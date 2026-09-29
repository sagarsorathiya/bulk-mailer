'use strict';

/**
 * services/attachmentResolver.js
 *
 * Resolves the full file path for an attachment given a row and job config.
 *
 * Mode 1 — ZIP bundle:
 *   The AttachmentPath column contains a filename only, e.g. "employee_form16.pdf"
 *   Files are pre-extracted from an uploaded ZIP into UPLOAD_DIR/<jobId>/
 *   This module resolves the full local path from the extracted folder.
 *
 * Mode 2 — Network/absolute path:
 *   The AttachmentPath column contains a full UNC or absolute path,
 *   e.g. \\SERVER\hr\form16\alice.pdf  or  hr/form16/alice.pdf (relative)
 *   Relative paths are resolved against ATTACHMENT_BASE_PATH.
 *
 * Security: path traversal ("../") is blocked in all modes.
 *
 * Returns: string (absolute path) | null (if not found or blocked)
 * On null: caller should log as failed row — do not send a blank email.
 */

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const UPLOAD_DIR           = process.env.UPLOAD_DIR            || './uploads';
const ATTACHMENT_BASE_PATH = process.env.ATTACHMENT_BASE_PATH  || '';

/**
 * Detect and block path traversal attempts.
 * @param {string} p  Path segment to check
 * @returns {boolean} true if traversal detected
 */
function hasTraversal(p) {
  // First check raw string for Windows-style traversal before normalisation
  // (catches cases like '..\\secret' that split() alone might miss)
  if (/\.\.[\\/]/.test(p) || /[\\/]\.\./.test(p) || p === '..') {
    return true;
  }
  // Normalise separators then check each segment
  const normalised = p.replace(/\\/g, '/');
  return normalised.split('/').some((seg) => seg === '..' || seg.startsWith('..'));
}

/**
 * Resolve an attachment path for a single row.
 *
 * @param {object} options
 * @param {string} options.attachmentValue  Value from the AttachmentPath column
 * @param {string} options.mode             'zip' | 'network'
 * @param {number|string} options.jobId     Job ID (used for ZIP extraction folder)
 * @returns {string|null}  Absolute resolved path, or null on failure
 */
function resolve({ attachmentValue, mode, jobId }) {
  if (!attachmentValue || !String(attachmentValue).trim()) {
    console.warn('[attachmentResolver] Empty attachment value');
    return null;
  }

  const value = String(attachmentValue).trim();

  // Block path traversal in all modes
  if (hasTraversal(value)) {
    console.warn('[attachmentResolver] Path traversal blocked:', value);
    return null;
  }

  if (mode === 'zip') {
    return resolveZip(value, jobId);
  }

  return resolveNetwork(value);
}

/**
 * ZIP mode — resolve filename inside extracted job folder.
 * @param {string}        filename  Bare filename, e.g. "employee_form16.pdf"
 * @param {number|string} jobId
 * @returns {string|null}
 */
function resolveZip(filename, jobId) {
  const extractedDir = path.resolve(UPLOAD_DIR, String(jobId));

  // Normalise separators: treat both \ and / as path separators
  const normalised = filename.replace(/\\/g, path.sep);

  // Strategy 1 — try the full relative path as given (preserves sub-folders from ZIP)
  const fullPath = path.join(extractedDir, normalised);
  // Security: ensure path stays inside extraction dir
  if (fullPath.startsWith(path.resolve(extractedDir))) {
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Strategy 2 — fall back to bare filename (for ZIPs that flatten everything to root)
  const bare         = path.basename(normalised);
  const bareFullPath = path.join(extractedDir, bare);
  if (bareFullPath.startsWith(path.resolve(extractedDir)) && fs.existsSync(bareFullPath)) {
    console.warn('[attachmentResolver] ZIP mode: found via bare filename fallback:', bare);
    return bareFullPath;
  }

  // Strategy 3 — recursive search by filename across all sub-folders
  const found = findFileRecursive(extractedDir, bare);
  if (found) {
    console.warn('[attachmentResolver] ZIP mode: found via recursive search:', found);
    return found;
  }

  console.warn('[attachmentResolver] ZIP mode: file not found:', filename, '(looked in:', extractedDir, ')');
  return null;
}

/**
 * Recursively search for a file by name inside a directory.
 * Used as last-resort fallback for ZIP mode.
 * @param {string} dir       Directory to search
 * @param {string} filename  Bare filename to find
 * @returns {string|null}    First matching absolute path, or null
 */
function findFileRecursive(dir, filename) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Network/absolute mode — resolve UNC, absolute, or relative path.
 * @param {string} value  Full UNC/absolute path, or relative to ATTACHMENT_BASE_PATH
 * @returns {string|null}
 */
function resolveNetwork(value) {
  let fullPath;

  // UNC path (Windows \\server\share\...) or absolute Windows / POSIX path
  if (value.startsWith('\\\\') || path.isAbsolute(value)) {
    fullPath = value;
  } else if (ATTACHMENT_BASE_PATH) {
    // Relative: join with base
    fullPath = path.join(ATTACHMENT_BASE_PATH, value);
  } else {
    // No base configured — treat as-is (may fail existsSync below)
    fullPath = value;
  }

  // For UNC paths on Windows, existsSync should still work if the share is mounted
  if (!fs.existsSync(fullPath)) {
    console.warn('[attachmentResolver] Network mode: file not found:', fullPath);
    return null;
  }

  return fullPath;
}

/**
 * Extract a ZIP file into UPLOAD_DIR/<jobId>/
 * Called by routes/jobs.js when attachment mode is 'zip'.
 *
 * @param {string}        zipPath   Full path to the uploaded ZIP file
 * @param {number|string} jobId
 * @returns {string}  Path to the extraction directory
 */
function extractZip(zipPath, jobId) {
  const AdmZip   = require('adm-zip');
  const destDir  = path.resolve(UPLOAD_DIR, String(jobId));

  fs.mkdirSync(destDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, /* overwrite */ true);

  console.log('[attachmentResolver] Extracted ZIP to:', destDir);
  return destDir;
}

/**
 * Resolve multiple attachment paths from a semicolon-separated value.
 * e.g. "form16.pdf;tds.pdf" → resolves each path individually.
 *
 * @param {object} options
 * @param {string} options.attachmentValue  Raw value (may contain semicolons)
 * @param {string} options.mode             'zip' | 'network'
 * @param {number|string} options.jobId
 * @returns {{ paths: string[], errors: string[] }}
 */
function resolveMultiple({ attachmentValue, mode, jobId }) {
  if (!attachmentValue || !String(attachmentValue).trim()) {
    return { paths: [], errors: [] };
  }

  const parts = String(attachmentValue).split(';').map((p) => p.trim()).filter(Boolean);
  const paths  = [];
  const errors = [];

  for (const part of parts) {
    const resolved = resolve({ attachmentValue: part, mode, jobId });
    if (resolved) {
      paths.push(resolved);
    } else {
      errors.push(`Attachment not found: ${part}`);
    }
  }

  return { paths, errors };
}

module.exports = { resolve, resolveMultiple, extractZip };
