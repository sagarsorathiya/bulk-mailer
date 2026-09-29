'use strict';

/**
 * routes/logs.js
 *
 * GET /api/logs?jobId=&status=&page=&limit=  → paginated send logs
 * GET /api/logs/:jobId/export                → download CSV of all logs for job
 */

const router          = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { query }       = require('../config/db');

// ── Validate :jobId param ──
router.param('jobId', (req, res, next, id) => {
  const parsed = parseInt(id, 10);
  if (isNaN(parsed) || parsed < 1) {
    return res.status(400).json({ success: false, error: 'Invalid job ID.' });
  }
  req.params.jobId = parsed;
  next();
});

// ──────────────────────────────────────────────
// GET /api/logs — Paginated send logs
// ──────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { jobId, status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    // Build WHERE clauses — always scope to current user's jobs
    const conditions = [`j.created_by = $1`];
    const params     = [req.user.username];
    let   paramIdx   = 2;

    if (jobId) {
      const jobIdInt = parseInt(jobId, 10);
      if (isNaN(jobIdInt) || jobIdInt < 1) {
        return res.status(400).json({ success: false, error: 'Invalid jobId filter.' });
      }
      conditions.push(`sl.job_id = $${paramIdx++}`);
      params.push(jobIdInt);
    }

    if (status && ['pending', 'sent', 'failed', 'skipped'].includes(status)) {
      conditions.push(`sl.status = $${paramIdx++}`);
      params.push(status);
    }

    const whereClause = conditions.join(' AND ');

    // Total count for pagination
    const countResult = await query(
      `SELECT COUNT(*) AS total
       FROM send_logs sl
       JOIN jobs j ON j.id = sl.job_id
       WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Paginated rows
    const rowsResult = await query(
      `SELECT sl.id, sl.job_id, sl.recipient_email, sl.recipient_name,
              sl.subject, sl.attachment_path, sl.status, sl.error_message,
              sl.sent_at, sl.created_at,
              j.from_address, j.status AS job_status
       FROM send_logs sl
       JOIN jobs j ON j.id = sl.job_id
       WHERE ${whereClause}
       ORDER BY sl.id DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...params, limit, offset]
    );

    return res.json({
      success: true,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      logs:  rowsResult.rows,
    });

  } catch (err) {
    console.error('[logs/list]', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Failed to fetch logs.' });
  }
});

// ──────────────────────────────────────────────
// GET /api/logs/:jobId/export — Download CSV
// ──────────────────────────────────────────────
router.get('/:jobId/export', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId, 10);

    // Verify the job belongs to the requesting user
    const jobCheck = await query(
      `SELECT id, created_by FROM jobs WHERE id = $1 AND created_by = $2`,
      [jobId, req.user.username]
    );

    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    // Fetch all logs for the job
    const result = await query(
      `SELECT sl.id, sl.recipient_email, sl.recipient_name,
              sl.subject, sl.attachment_path, sl.status,
              sl.error_message, sl.sent_at, sl.created_at
       FROM send_logs sl
       WHERE sl.job_id = $1
       ORDER BY sl.id ASC`,
      [jobId]
    );

    // Build CSV
    const csvHeaders = [
      'ID', 'RecipientEmail', 'RecipientName', 'Subject',
      'AttachmentPath', 'Status', 'ErrorMessage', 'SentAt', 'CreatedAt',
    ];

    function escapeCsv(value) {
      if (value === null || value === undefined) return '';
      const str = String(value);
      // Quote strings that contain comma, newline, or double-quote
      if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    const csvLines = [csvHeaders.join(',')];
    for (const row of result.rows) {
      csvLines.push([
        escapeCsv(row.id),
        escapeCsv(row.recipient_email),
        escapeCsv(row.recipient_name),
        escapeCsv(row.subject),
        escapeCsv(row.attachment_path),
        escapeCsv(row.status),
        escapeCsv(row.error_message),
        escapeCsv(row.sent_at),
        escapeCsv(row.created_at),
      ].join(','));
    }

    const csv = csvLines.join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="job-${jobId}-logs.csv"`);
    // BOM for Excel UTF-8 compatibility
    return res.send('\uFEFF' + csv);

  } catch (err) {
    console.error('[logs/export]', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Failed to export logs.' });
  }
});

module.exports = router;
