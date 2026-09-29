'use strict';

/**
 * routes/preview.js
 *
 * POST /api/preview
 * Body: { subjectTemplate, bodyTemplate, rows: [row1, row2, row3] }
 * Response: { previews: [{ email, subject, body, attachmentPath }] }
 *
 * Merges templates with up to 3 sample rows. No sending, no DB writes.
 */

const router          = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { merge }       = require('../services/templateEngine');

/**
 * POST /api/preview
 */
router.post('/', requireAuth, (req, res) => {
  try {
    const { subjectTemplate, bodyTemplate, rows } = req.body;

    if (!subjectTemplate || !bodyTemplate) {
      return res.status(400).json({
        success: false,
        error: 'subjectTemplate and bodyTemplate are required.',
      });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'rows must be a non-empty array.',
      });
    }

    // Preview up to 3 rows
    const previewRows = rows.slice(0, 3);

    const previews = previewRows.map((row) => {
      const rowKeys = Object.keys(row);
      const emailKey      = rowKeys.find((k) => k.toLowerCase() === 'email')          || 'Email';
      const attachmentKey = rowKeys.find((k) => k.toLowerCase() === 'attachmentpath') || 'AttachmentPath';
      const ccKey         = rowKeys.find((k) => k.toLowerCase() === 'cc')             || null;
      const bccKey        = rowKeys.find((k) => k.toLowerCase() === 'bcc')            || null;

      return {
        email:          row[emailKey]               || '',
        cc:             ccKey  ? (row[ccKey]  || '') : '',
        bcc:            bccKey ? (row[bccKey] || '') : '',
        subject:        merge(subjectTemplate, row, 'subject'),
        body:           merge(bodyTemplate,    row, 'body'),
        attachmentPath: row[attachmentKey]          || '',
      };
    });

    return res.json({ success: true, previews });

  } catch (err) {
    console.error('[preview]', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Preview generation failed.' });
  }
});

module.exports = router;
