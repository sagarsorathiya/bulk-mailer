'use strict';

/**
 * middleware/upload.js
 *
 * Multer configuration for file uploads:
 *   - excel: .xlsx or .csv, max 50 MB
 *   - attachments: .zip, max 500 MB
 *
 * Files are stored in UPLOAD_DIR/tmp/ with unique names.
 * Routes move/process them after successful upload.
 */

require('dotenv').config();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const TMP_DIR    = path.join(UPLOAD_DIR, 'tmp');

// Ensure tmp directory exists
fs.mkdirSync(TMP_DIR, { recursive: true });

// ──────────────────────────────────────────────
// Storage: disk, unique filenames
// ──────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, file, cb) => {
    const uid  = crypto.randomBytes(8).toString('hex');
    const ext  = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${uid}${ext}`);
  },
});

// ──────────────────────────────────────────────
// File filter: only allowed extensions
// ──────────────────────────────────────────────
const EXCEL_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                           // .xls
  'text/csv',
  'application/csv',
];
const ZIP_MIMES = [
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream', // some browsers send this for ZIP
];

function fileFilter(_req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;

  const isExcel = ['.xlsx', '.xls', '.csv'].includes(ext) || EXCEL_MIMES.includes(mime);
  const isZip   = ext === '.zip' || ZIP_MIMES.includes(mime);

  if (isExcel || isZip) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `Unsupported file type: ${ext || mime}`));
  }
}

// ──────────────────────────────────────────────
// Upload instances
// ──────────────────────────────────────────────

/**
 * Handles the job creation multipart form:
 *   - excel (required, max 50MB)
 *   - attachments (optional ZIP, max 500MB)
 */
const jobUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB (ZIP is the larger limit)
    files:    2,
  },
}).fields([
  { name: 'excel',       maxCount: 1 },
  { name: 'attachments', maxCount: 1 },
]);

/**
 * Middleware wrapper that enforces per-field size limits after upload.
 * multer doesn't support per-field limits natively so we validate post-hoc.
 */
function jobUploadMiddleware(req, res, next) {
  jobUpload(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
      }
      return res.status(500).json({ success: false, error: `Upload failed: ${err.message}` });
    }

    // Enforce 50 MB limit on Excel file
    const excelFile = req.files && req.files['excel'] && req.files['excel'][0];
    if (excelFile && excelFile.size > 50 * 1024 * 1024) {
      fs.unlinkSync(excelFile.path);
      return res.status(400).json({ success: false, error: 'Excel file exceeds 50 MB limit.' });
    }

    next();
  });
}

module.exports = { jobUploadMiddleware };
