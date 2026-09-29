'use strict';

/**
 * routes/stats.js
 *
 * GET /api/stats — Aggregate statistics for the dashboard page.
 *
 * Response:
 *   {
 *     totalJobs:      number,   // all-time jobs by current user
 *     totalSent:      number,   // all-time sent rows
 *     totalFailed:    number,   // all-time failed rows
 *     activeJobs:     number,   // currently running jobs
 *     thisMonthJobs:  number,   // jobs created this calendar month
 *     thisMonthSent:  number,   // emails sent this calendar month
 *     successRate:    number,   // sent / (sent + failed) * 100, or null if no data
 *     recentJobs:     object[], // last 10 jobs (summary)
 *   }
 */

const router            = require('express').Router();
const { requireAuth }   = require('../middleware/auth');
const { query }         = require('../config/db');

// GET /api/stats
router.get('/', requireAuth, async (req, res) => {
  try {
    const username = req.user.username;

    // All-time totals for this user
    const totalsResult = await query(
      `SELECT
         COUNT(*)                          AS total_jobs,
         COALESCE(SUM(sent_count),   0)   AS total_sent,
         COALESCE(SUM(failed_count), 0)   AS total_failed,
         COUNT(*) FILTER (WHERE status = 'running') AS active_jobs
       FROM jobs
       WHERE created_by = $1`,
      [username]
    );

    const totals = totalsResult.rows[0];

    // This calendar month
    const monthResult = await query(
      `SELECT
         COUNT(*)                          AS this_month_jobs,
         COALESCE(SUM(sent_count),   0)   AS this_month_sent
       FROM jobs
       WHERE created_by = $1
         AND created_at >= date_trunc('month', NOW())`,
      [username]
    );

    const month = monthResult.rows[0];

    // Last 10 jobs (for the recent-jobs table on dashboard)
    const recentResult = await query(
      `SELECT id, from_address, department, total_rows, sent_count, failed_count,
              status, scheduled_at, started_at, completed_at, created_at
       FROM jobs
       WHERE created_by = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [username]
    );

    const totalSent   = parseInt(totals.total_sent,   10);
    const totalFailed = parseInt(totals.total_failed, 10);
    const totalDone   = totalSent + totalFailed;
    const successRate = totalDone > 0
      ? Math.round((totalSent / totalDone) * 100)
      : null;

    return res.json({
      success: true,
      stats: {
        totalJobs:     parseInt(totals.total_jobs,       10),
        totalSent,
        totalFailed,
        activeJobs:    parseInt(totals.active_jobs,      10),
        thisMonthJobs: parseInt(month.this_month_jobs,   10),
        thisMonthSent: parseInt(month.this_month_sent,   10),
        successRate,
        recentJobs:    recentResult.rows,
      },
    });
  } catch (err) {
    console.error('[stats]', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Failed to load stats.' });
  }
});

module.exports = router;
