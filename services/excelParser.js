'use strict';

/**
 * services/excelParser.js
 *
 * Parse an uploaded Excel (.xlsx) or CSV file.
 * Validates that required columns are present: Email, AttachmentPath
 * All column headers become available as template placeholder keys.
 *
 * Returns: { columns: string[], rows: object[], errors: string[] }
 */

const xlsx = require('xlsx');
const path = require('path');

// Required columns (case-insensitive check)
const REQUIRED_COLUMNS = ['email', 'attachmentpath'];

// Basic email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise a header string to lower-case trimmed form for comparison.
 * @param {string} h
 * @returns {string}
 */
function normaliseKey(h) {
  return String(h).trim().toLowerCase();
}

/**
 * Find the original-case header that matches the normalised key.
 * @param {string[]} headers   Original case headers from sheet
 * @param {string}   normKey   Normalised target key
 * @returns {string|null}
 */
function findHeader(headers, normKey) {
  return headers.find((h) => normaliseKey(h) === normKey) || null;
}

/**
 * Parse an Excel or CSV file buffer.
 *
 * @param {Buffer} buffer      File buffer
 * @param {string} originalName  Original filename (used to detect CSV)
 * @returns {{ columns: string[], rows: object[], errors: string[] }}
 */
function parseExcel(buffer, originalName) {
  const errors = [];

  // Parse workbook from buffer
  const ext = path.extname(originalName || '').toLowerCase();
  const opts = { type: 'buffer', cellDates: true };
  let workbook;
  try {
    workbook = xlsx.read(buffer, opts);
  } catch (err) {
    return { columns: [], rows: [], errors: [`Failed to parse file: ${err.message}`] };
  }

  // Use first sheet
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { columns: [], rows: [], errors: ['Excel file has no sheets.'] };
  }
  const sheet = workbook.Sheets[sheetName];

  // Convert to array of objects (header row → keys)
  const rawRows = xlsx.utils.sheet_to_json(sheet, {
    defval: '',       // fill missing cells with ''
    raw:    false,    // format dates as strings
  });

  if (rawRows.length === 0) {
    return { columns: [], rows: [], errors: ['Excel sheet is empty or has no data rows.'] };
  }

  // Collect columns from first row's keys
  const columns = Object.keys(rawRows[0]).map((h) => String(h).trim());

  // Validate required columns
  for (const required of REQUIRED_COLUMNS) {
    if (!findHeader(columns, required)) {
      errors.push(`Missing required column: "${required}" (case-insensitive). Found columns: ${columns.join(', ')}`);
    }
  }

  if (errors.length > 0) {
    return { columns, rows: [], errors };
  }

  // Resolve actual column names (original case)
  const emailCol      = findHeader(columns, 'email');
  const attachmentCol = findHeader(columns, 'attachmentpath');

  const rows = [];
  let rowIndex = 2; // 1-indexed, row 1 = header

  for (const rawRow of rawRows) {
    // Normalise all keys (trim whitespace from keys and values)
    const row = {};
    for (const [k, v] of Object.entries(rawRow)) {
      row[String(k).trim()] = v != null ? String(v).trim() : '';
    }

    // Skip entirely blank rows
    const allEmpty = Object.values(row).every((v) => v === '');
    if (allEmpty) {
      rowIndex++;
      continue;
    }

    const email = row[emailCol] || '';

    // Validate email format — warn but still include row so it appears in logs
    if (!EMAIL_REGEX.test(email)) {
      errors.push(`Row ${rowIndex}: invalid email "${email}" — row will be marked failed during send.`);
    }

    // Warn on missing attachment path
    const attachmentPath = row[attachmentCol] || '';
    if (!attachmentPath) {
      errors.push(`Row ${rowIndex}: missing AttachmentPath — row will be marked failed during send.`);
    }

    rows.push(row);
    rowIndex++;
  }

  return { columns, rows, errors };
}

module.exports = { parseExcel };
