'use strict';

/**
 * routes/jobs.js
 *
 * POST   /api/jobs             — Create job: parse Excel, insert send_log rows
 * GET    /api/jobs             — List jobs for current user
 * GET    /api/jobs/:id         — Job detail + progress
 * POST   /api/jobs/:id/start   — Enqueue job into Bull queue
 * POST   /api/jobs/:id/pause   — Pause running job
 * POST   /api/jobs/:id/retry   — Re-queue only failed rows
 * DELETE /api/jobs/:id         — Cancel + delete job + logs
 */

const router                = require('express').Router();
const path                  = require('path');
const fs                    = require('fs');
const XLSX                  = require('xlsx');
const { requireAuth }       = require('../middleware/auth');
const { jobUploadMiddleware } = require('../middleware/upload');
const { parseExcel }        = require('../services/excelParser');
const { extractZip }        = require('../services/attachmentResolver');
const { merge }             = require('../services/templateEngine');
const allowedSenders        = require('../config/allowedSenders');
const { query, getClient }  = require('../config/db');

const MAX_BATCH_SIZE = parseInt(process.env.MAX_BATCH_SIZE || '500', 10);

// ── Validate :id param for all /:id routes ──
router.param('id', (req, res, next, id) => {
  const parsed = parseInt(id, 10);
  if (isNaN(parsed) || parsed < 1) {
    return res.status(400).json({ success: false, error: 'Invalid job ID.' });
  }
  req.params.id = parsed;
  next();
});

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Validate that fromAddress is allowed for the user's department.
 * Admins bypass the check.
 */
function isFromAddressAllowed(fromAddress, department) {
  if (department === 'Admin') return true;
  const allowed = allowedSenders[department] || [];
  return allowed.includes(fromAddress);
}

/**
 * Lazy-load the Bull queue to avoid circular dependency with jobProcessor.
 */
function getQueue() {
  // eslint-disable-next-line global-require
  return require('../services/jobProcessor').getQueue();
}

// ──────────────────────────────────────────────
// GET /api/jobs/sample-excel — Download sample Excel
// ──────────────────────────────────────────────
/**
 * Returns a sample .xlsx file so users know the expected column format.
 * Columns: Name, Email, EmployeeID, Department, AttachmentPath
 * Two demo rows are included to illustrate placeholder values.
 */
router.get('/sample-excel', requireAuth, (_req, res) => {
  try {
    const sampleData = [
      {
        Name:           'Alice Example',
        Email:          'alice@example.com',
        EmployeeID:     'EMP001',
        Department:     'Finance',
        AttachmentPath: '\\\\SERVER\\hr\\Form16\\EMP001_Form16.pdf',
      },
      {
        Name:           'Bob Example',
        Email:          'bob@example.com',
        EmployeeID:     'EMP002',
        Department:     'HR',
        AttachmentPath: '\\\\SERVER\\hr\\Form16\\EMP002_Form16.pdf',
      },
      {
        Name:           'Carol Example',
        Email:          'carol@example.com',
        EmployeeID:     'EMP003',
        Department:     'IT',
        AttachmentPath: '\\\\SERVER\\hr\\Form16\\EMP003_Form16.pdf',
      },
    ];

    const worksheet  = XLSX.utils.json_to_sheet(sampleData);

    // Set column widths for readability
    worksheet['!cols'] = [
      { wch: 20 }, // Name
      { wch: 32 }, // Email
      { wch: 12 }, // EmployeeID
      { wch: 16 }, // Department
      { wch: 52 }, // AttachmentPath
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Recipients');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="sample_bulk_mail.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    console.error('[jobs/sample-excel]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to generate sample Excel.' });
  }
});

// ──────────────────────────────────────────────
// POST /api/jobs/parse — Parse Excel only, no DB writes
// Returns columns, preview rows and validation warnings so the
// frontend can show chips and validate BEFORE compose fields are filled.
// ──────────────────────────────────────────────
router.post('/parse', requireAuth, jobUploadMiddleware, async (req, res) => {
  try {
    const excelFile = req.files && req.files['excel'] && req.files['excel'][0];
    if (!excelFile) {
      return res.status(400).json({ success: false, error: 'Excel file is required.' });
    }

    const excelBuffer = fs.readFileSync(excelFile.path);
    const { columns, rows, errors: parseErrors } = parseExcel(excelBuffer, excelFile.originalname);

    // Clean up temp file immediately — we don't persist anything
    fs.unlink(excelFile.path, () => {});
    const zipFile = req.files && req.files['attachments'] && req.files['attachments'][0];
    if (zipFile) fs.unlink(zipFile.path, () => {});

    const fatalErrors = parseErrors.filter((e) =>
      e.startsWith('Missing required column') || e.startsWith('Failed to parse') || e.startsWith('Excel')
    );
    if (fatalErrors.length > 0) {
      return res.status(400).json({ success: false, error: fatalErrors.join(' | ') });
    }
    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'No data rows found in Excel.' });
    }

    const emailCol  = columns.find((c) => c.toLowerCase() === 'email') || 'Email';
    const attachCol = columns.find((c) => c.toLowerCase() === 'attachmentpath') || 'AttachmentPath';

    const previewRows = rows.slice(0, 3).map((row) => ({
      email:          row[emailCol]  || '',
      attachmentPath: row[attachCol] || '',
    }));

    return res.json({
      success:     true,
      totalRows:   rows.length,
      columns,
      parseErrors,
      previewRows,
    });
  } catch (err) {
    console.error('[jobs/parse]', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Failed to parse Excel.' });
  }
});

// ──────────────────────────────────────────────
// POST /api/jobs — Create job
// ──────────────────────────────────────────────
router.post('/', requireAuth, jobUploadMiddleware, async (req, res) => {
  const client = await getClient();
  try {
    const {
      fromAddress,
      subjectTemplate,
      bodyTemplate,
      attachmentMode,
      scheduledAt,
    } = req.body;

    // ── Validate required fields ──
    if (!fromAddress || !subjectTemplate || !bodyTemplate) {
      return res.status(400).json({
        success: false,
        error: 'fromAddress, subjectTemplate, and bodyTemplate are required.',
      });
    }

    const mode = attachmentMode === 'zip' ? 'zip' : 'network';

    // ── Validate from address ──
    if (!isFromAddressAllowed(fromAddress, req.user.department)) {
      return res.status(403).json({
        success: false,
        error: `From address "${fromAddress}" is not permitted for ${req.user.department} department.`,
      });
    }

    // ── Validate Excel upload ──
    const excelFile = req.files && req.files['excel'] && req.files['excel'][0];
    if (!excelFile) {
      return res.status(400).json({ success: false, error: 'Excel file is required.' });
    }

    // ── Parse Excel ──
    const excelBuffer = fs.readFileSync(excelFile.path);
    const { columns, rows, errors: parseErrors } = parseExcel(excelBuffer, excelFile.originalname);

    // Column validation errors are fatal; row-level warnings are informational
    const fatalErrors = parseErrors.filter((e) =>
      e.startsWith('Missing required column') || e.startsWith('Failed to parse') || e.startsWith('Excel')
    );
    if (fatalErrors.length > 0) {
      return res.status(400).json({ success: false, error: fatalErrors.join(' | ') });
    }

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'No data rows found in Excel.' });
    }

    if (rows.length > MAX_BATCH_SIZE) {
      return res.status(400).json({
        success: false,
        error: `Batch size ${rows.length} exceeds MAX_BATCH_SIZE of ${MAX_BATCH_SIZE}.`,
      });
    }

    // ── Create job record ──
    await client.query('BEGIN');

    const jobResult = await client.query(
      `INSERT INTO jobs
         (created_by, department, from_address, subject_tpl, body_tpl, attachment_mode, total_rows, status, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       RETURNING id`,
      [
        req.user.username,
        req.user.department,
        fromAddress,
        subjectTemplate,
        bodyTemplate,
        mode,
        rows.length,
        scheduledAt || null,
      ]
    );

    const jobId = jobResult.rows[0].id;

    // ── Handle ZIP extraction ──
    if (mode === 'zip') {
      const zipFile = req.files && req.files['attachments'] && req.files['attachments'][0];
      if (!zipFile) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'ZIP file is required when attachment mode is "zip".' });
      }
      try {
        extractZip(zipFile.path, jobId);
      } catch (zipErr) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: `Failed to extract ZIP: ${zipErr.message}` });
      }
      // Clean up temp ZIP
      fs.unlink(zipFile.path, () => {});
    }

    // ── Insert send_log rows ──
    // Find column names (case-insensitive)
    const emailCol = columns.find((c) => c.toLowerCase() === 'email') || 'Email';
    const attachCol = columns.find((c) => c.toLowerCase() === 'attachmentpath') || 'AttachmentPath';
    const nameCol = columns.find((c) => ['name', 'recipientname', 'recipient_name'].includes(c.toLowerCase())) || null;

    for (const row of rows) {
      const recipientEmail = row[emailCol] || '';
      const recipientName  = nameCol ? (row[nameCol] || '') : '';
      const attachmentPath = row[attachCol] || '';
      const mergedSubject  = merge(subjectTemplate, row, 'subject');

      await client.query(
        `INSERT INTO send_logs
           (job_id, recipient_email, recipient_name, subject, attachment_path, row_data, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [jobId, recipientEmail, recipientName, mergedSubject, attachmentPath, JSON.stringify(row)]
      );
    }

    await client.query('COMMIT');

    // ── Build preview (first 3 rows) ──
    const previewRows = rows.slice(0, 3).map((row) => ({
      email:          row[emailCol],
      subject:        merge(subjectTemplate, row, 'subject'),
      body:           merge(bodyTemplate, row, 'body'),
      attachmentPath: row[attachCol],
    }));

    // Clean up temp Excel file
    fs.unlink(excelFile.path, () => {});

    return res.json({
      success:     true,
      jobId,
      totalRows:   rows.length,
      columns,
      parseErrors, // row-level warnings
      previewRows,
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[jobs/create]', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Failed to create job.' });
  } finally {
    client.release();
  }
});

// ──────────────────────────────────────────────
// GET /api/jobs — List jobs for current user
// ──────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, created_by, department, from_address, attachment_mode,
              total_rows, sent_count, failed_count, status,
              scheduled_at, started_at, completed_at, created_at
       FROM jobs
       WHERE created_by = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.username]
    );
    return res.json({ success: true, jobs: result.rows });
  } catch (err) {
    console.error('[jobs/list]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch jobs.' });
  }
});

// ──────────────────────────────────────────────
// GET /api/jobs/:id — Job detail + progress
// ──────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const result = await query(
      `SELECT id, created_by, department, from_address, subject_tpl, body_tpl,
              attachment_mode, total_rows, sent_count, failed_count, status,
              scheduled_at, started_at, completed_at, created_at
       FROM jobs
       WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    // Recent log rows for live display (last 50)
    const logs = await query(
      `SELECT id, recipient_email, recipient_name, subject, attachment_path,
              status, error_message, sent_at, created_at
       FROM send_logs
       WHERE job_id = $1
       ORDER BY id DESC
       LIMIT 50`,
      [jobId]
    );

    return res.json({ success: true, job: result.rows[0], recentLogs: logs.rows });
  } catch (err) {
    console.error('[jobs/detail]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch job.' });
  }
});

// ──────────────────────────────────────────────
// POST /api/jobs/:id/start — Enqueue job into Bull
// ──────────────────────────────────────────────
router.post('/:id/start', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const jobRow = await query(
      `SELECT id, status, scheduled_at FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );

    if (jobRow.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    const job = jobRow.rows[0];
    if (!['pending', 'paused'].includes(job.status)) {
      return res.status(400).json({ success: false, error: `Job is already ${job.status}.` });
    }

    // Update status to running
    await query(
      `UPDATE jobs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [jobId]
    );

    // Enqueue into Bull
    const queue = getQueue();
    const delay = job.scheduled_at
      ? Math.max(0, new Date(job.scheduled_at) - Date.now())
      : 0;

    await queue.add('send-job', { jobId }, { delay, jobId: String(jobId) });

    return res.json({ success: true, message: 'Job enqueued.' });
  } catch (err) {
    console.error('[jobs/start]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to start job.' });
  }
});

// ──────────────────────────────────────────────
// POST /api/jobs/:id/pause — Pause running job
// ──────────────────────────────────────────────
router.post('/:id/pause', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const jobRow = await query(
      `SELECT id, status FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );

    if (jobRow.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    if (jobRow.rows[0].status !== 'running') {
      return res.status(400).json({ success: false, error: 'Only running jobs can be paused.' });
    }

    await query(`UPDATE jobs SET status = 'paused' WHERE id = $1`, [jobId]);

    return res.json({ success: true, message: 'Job paused. Current send will complete then stop.' });
  } catch (err) {
    console.error('[jobs/pause]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to pause job.' });
  }
});

// ──────────────────────────────────────────────
// POST /api/jobs/:id/retry — Re-queue failed rows
// ──────────────────────────────────────────────
router.post('/:id/retry', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const jobRow = await query(
      `SELECT id, status, failed_count, sent_count FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );

    if (jobRow.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    const job = jobRow.rows[0];
    if (job.failed_count === 0) {
      return res.status(400).json({ success: false, error: 'No failed rows to retry.' });
    }

    // Reset failed rows back to pending
    const resetResult = await query(
      `UPDATE send_logs
       SET status = 'pending', error_message = NULL, sent_at = NULL
       WHERE job_id = $1 AND status = 'failed'`,
      [jobId]
    );

    const retried = resetResult.rowCount;

    // Reset job counters and status.
    // Subtract retried rows from sent_count so the progress bar restarts
    // accurately — otherwise sent_count stays inflated while failed_count resets to 0.
    await query(
      `UPDATE jobs
       SET status       = 'running',
           failed_count = 0,
           sent_count   = GREATEST(0, sent_count - $2),
           started_at   = NOW()
       WHERE id = $1`,
      [jobId, retried]
    );

    // Re-enqueue
    const queue = getQueue();
    await queue.add('send-job', { jobId, retryOnly: true }, { jobId: String(jobId) + '-retry' });

    return res.json({
      success: true,
      message: `Re-queued ${retried} failed rows.`,
      rowsReset: retried,
    });
  } catch (err) {
    console.error('[jobs/retry]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to retry job.' });
  }
});

// ──────────────────────────────────────────────
// POST /api/jobs/:id/schedule — Update scheduled_at on a pending job
// ──────────────────────────────────────────────
/**
 * Allows updating (or clearing) the scheduled send time on a pending job
 * before it has been started. Pass { scheduledAt: ISO8601 } to set, or
 * { scheduledAt: null } to clear (send immediately on next /start).
 */
router.post('/:id/schedule', requireAuth, async (req, res) => {
  try {
    const jobId      = parseInt(req.params.id, 10);
    const { scheduledAt } = req.body;

    const jobRow = await query(
      `SELECT id, status FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );

    if (jobRow.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    if (jobRow.rows[0].status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: 'Schedule can only be changed on pending jobs. Pause and recreate if needed.',
      });
    }

    // Validate the provided date (if not null/empty)
    let parsedDate = null;
    if (scheduledAt) {
      parsedDate = new Date(scheduledAt);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid scheduledAt date.' });
      }
    }

    await query(
      `UPDATE jobs SET scheduled_at = $1 WHERE id = $2`,
      [parsedDate || null, jobId]
    );

    return res.json({
      success: true,
      message: parsedDate
        ? `Job scheduled for ${parsedDate.toISOString()}.`
        : 'Schedule cleared — job will send immediately on start.',
      scheduledAt: parsedDate ? parsedDate.toISOString() : null,
    });
  } catch (err) {
    console.error('[jobs/schedule]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update schedule.' });
  }
});

// ──────────────────────────────────────────────
// DELETE /api/jobs/:id — Cancel + delete job
// ──────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);

    // Verify ownership before doing anything
    const existing = await query(
      `SELECT id, status FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    // Cancel any in-flight Bull job BEFORE deleting from DB.
    // Without this, the worker continues processing and hits missing rows
    // after the FK cascade removes send_logs, causing DB errors.
    try {
      const queue = getQueue();
      // removeJobs removes waiting/delayed jobs; for active ones we signal via DB status
      await queue.removeJobs(String(jobId)).catch(() => {});
      // Also mark job as failed in DB so the worker's pause-check loop exits cleanly
      // (it reads status every iteration)
    } catch (qErr) {
      console.warn('[jobs/delete] Could not cancel Bull job:', qErr.message);
    }

    // Delete from DB (send_logs cascade via FK)
    await query(
      `DELETE FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );

    // Clean up extracted ZIP folder if it exists
    const extractedDir = path.resolve(process.env.UPLOAD_DIR || './uploads', String(jobId));
    if (fs.existsSync(extractedDir)) {
      fs.rmSync(extractedDir, { recursive: true, force: true });
    }

    return res.json({ success: true, message: 'Job deleted.' });
  } catch (err) {
    console.error('[jobs/delete]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete job.' });
  }
});

module.exports = router;
