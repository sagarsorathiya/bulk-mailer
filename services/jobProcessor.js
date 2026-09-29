'use strict';

/**
 * services/jobProcessor.js
 *
 * Bull queue + worker for processing bulk mail jobs.
 *
 * Queue: "mail-jobs"
 * Worker processes one Bull job at a time (concurrency: 1).
 *
 * For each Bull job payload { jobId }:
 *   1. Load all send_log rows for job_id where status = 'pending'
 *   2. For each row:
 *      a. Check if job has been paused — if so, stop processing
 *      b. Resolve attachment path
 *      c. Merge templates with row data
 *      d. Send mail
 *      e. Update send_logs row status + sent_at or error_message
 *      f. Increment jobs.sent_count or jobs.failed_count
 *      g. Sleep SEND_DELAY_MS
 *   3. On completion: update jobs.status = 'completed', jobs.completed_at
 *   4. On unhandled error: update jobs.status = 'failed'
 *
 * Can be run standalone: node services/jobProcessor.js
 * Or required by routes to get the queue reference.
 */

require('dotenv').config();
const Bull              = require('bull');
const { query }         = require('../config/db');
const { redisConfig }   = require('../config/redis');
const { resolveMultiple } = require('./attachmentResolver');
const { merge }         = require('./templateEngine');
const { sendMail }      = require('./mailSender');

const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || '2000', 10);
const QUEUE_NAME    = 'mail-jobs';

// ── Create Bull queue ──
const mailQueue = new Bull(QUEUE_NAME, { redis: redisConfig });

/**
 * Sleep for the configured delay between sends.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the current job status from DB to check for pause/cancel.
 * @param {number} jobId
 * @returns {Promise<string>} status string
 */
async function getJobStatus(jobId) {
  const result = await query('SELECT status FROM jobs WHERE id = $1', [jobId]);
  return result.rows[0] ? result.rows[0].status : 'unknown';
}

/**
 * Process a single mail job by jobId.
 * @param {number} jobId
 * @param {object} bullJob  Bull Job instance (for progress reporting)
 */
async function processMailJob(jobId, bullJob) {
  console.log(`[jobProcessor] Starting job ${jobId}`);

  // Load job metadata
  const jobResult = await query(
    `SELECT id, from_address, subject_tpl, body_tpl, attachment_mode, total_rows
     FROM jobs WHERE id = $1`,
    [jobId]
  );

  if (jobResult.rows.length === 0) {
    throw new Error(`Job ${jobId} not found in database.`);
  }

  const job = jobResult.rows[0];

  // Load pending send_log rows
  const logsResult = await query(
    `SELECT id, recipient_email, recipient_name, attachment_path, row_data
     FROM send_logs
     WHERE job_id = $1 AND status = 'pending'
     ORDER BY id ASC`,
    [jobId]
  );

  const logs      = logsResult.rows;
  const total     = logs.length;
  let   processed = 0;

  console.log(`[jobProcessor] Job ${jobId}: ${total} pending rows to process`);

  for (const log of logs) {
    // ── Check for pause signal ──
    const currentStatus = await getJobStatus(jobId);
    if (currentStatus === 'paused') {
      console.log(`[jobProcessor] Job ${jobId} paused — stopping after ${processed} rows`);
      return; // Leave remaining rows as 'pending' for resume
    }
    if (currentStatus === 'failed' || currentStatus === 'completed') {
      console.log(`[jobProcessor] Job ${jobId} status is ${currentStatus} — stopping`);
      return;
    }

    const rowData = typeof log.row_data === 'string'
      ? JSON.parse(log.row_data)
      : (log.row_data || {});

    // ── a. Resolve attachment paths (semicolon-separated = multiple files) ──
    let resolvedPaths = [];
    const rawAttachmentValue = log.attachment_path || '';

    if (rawAttachmentValue) {
      const { paths, errors: attachErrors } = resolveMultiple({
        attachmentValue: rawAttachmentValue,
        mode:            job.attachment_mode,
        jobId,
      });

      // If any attachment in the list is missing → fail the row, continue batch
      if (attachErrors.length > 0) {
        await query(
          `UPDATE send_logs
           SET status = 'failed', error_message = $1
           WHERE id = $2`,
          [attachErrors.join('; '), log.id]
        );
        await query(
          `UPDATE jobs SET failed_count = failed_count + 1 WHERE id = $1`,
          [jobId]
        );
        processed++;
        continue;
      }

      resolvedPaths = paths;
    }

    // ── b. Extract CC / BCC from row data (optional columns) ──
    const cc  = rowData['CC']  || rowData['cc']  || undefined;
    const bcc = rowData['BCC'] || rowData['bcc'] || undefined;

    // ── c. Merge templates ──
    const subject = merge(job.subject_tpl, rowData, 'subject');
    const html    = merge(job.body_tpl,    rowData, 'body');

    // ── d. Send mail ──
    const result = await sendMail({
      from:            job.from_address,
      to:              log.recipient_email,
      cc,
      bcc,
      subject,
      html,
      attachmentPaths: resolvedPaths,
    });

    // ── e+f. Update send_log ──
    if (result.success) {
      await query(
        `UPDATE send_logs
         SET status = 'sent', sent_at = NOW(), error_message = NULL
         WHERE id = $1`,
        [log.id]
      );
      await query(
        `UPDATE jobs SET sent_count = sent_count + 1 WHERE id = $1`,
        [jobId]
      );
    } else {
      await query(
        `UPDATE send_logs
         SET status = 'failed', error_message = $1
         WHERE id = $2`,
        [result.error || 'Unknown send error', log.id]
      );
      await query(
        `UPDATE jobs SET failed_count = failed_count + 1 WHERE id = $1`,
        [jobId]
      );
    }

    processed++;

    // ── Report progress to Bull ──
    if (bullJob && typeof bullJob.progress === 'function') {
      await bullJob.progress(Math.round((processed / total) * 100));
    }

    // ── g. Sleep between sends ──
    if (processed < total) {
      await sleep(SEND_DELAY_MS);
    }
  }

  // ── 3. Mark job completed (only if not paused/cancelled externally) ──
  const finalStatus = await getJobStatus(jobId);
  if (finalStatus === 'paused') {
    // Worker finished but the user paused it — leave status as 'paused'
    // so they can resume. Remaining rows (if any) are still 'pending'.
    console.log(`[jobProcessor] Job ${jobId} loop finished while paused — leaving status as 'paused'`);
    return;
  }
  if (finalStatus === 'failed' || finalStatus === 'completed') {
    // Was externally changed (e.g. deleted then re-inserted, or double-processed)
    console.log(`[jobProcessor] Job ${jobId} already in terminal state: ${finalStatus}`);
    return;
  }

  await query(
    `UPDATE jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
    [jobId]
  ).catch((e) => console.warn('[jobProcessor] Final status update failed (job may have been deleted):', e.message));

  console.log(`[jobProcessor] Job ${jobId} completed: ${processed} rows processed`);
}

// ── Register Bull worker ──
mailQueue.process('send-job', 1, async (bullJob) => {
  const { jobId } = bullJob.data;

  try {
    await processMailJob(jobId, bullJob);
  } catch (err) {
    console.error(`[jobProcessor] Job ${jobId} unhandled error:`, err.message, err.stack);

    // Mark job as failed in DB
    await query(
      `UPDATE jobs SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [jobId]
    ).catch((dbErr) => console.error('[jobProcessor] Failed to update job status to failed:', dbErr.message));

    throw err; // Let Bull record the failure
  }
});

// ── Queue event listeners ──
mailQueue.on('completed', (job) => {
  console.log(`[queue] Bull job ${job.id} completed`);
});

mailQueue.on('failed', (job, err) => {
  console.error(`[queue] Bull job ${job.id} failed:`, err.message);
});

mailQueue.on('error', (err) => {
  console.error('[queue] Queue error:', err.message);
});

/**
 * Get the queue instance (used by routes/jobs.js to enqueue jobs).
 * @returns {Bull.Queue}
 */
function getQueue() {
  return mailQueue;
}

module.exports = { getQueue };

// ── If run directly: keep worker alive ──
if (require.main === module) {
  console.log('[jobProcessor] Worker started — waiting for jobs on queue:', QUEUE_NAME);
  process.on('SIGTERM', async () => {
    console.log('[jobProcessor] SIGTERM received — closing queue gracefully');
    await mailQueue.close();
    process.exit(0);
  });
}
