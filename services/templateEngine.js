'use strict';

/**
 * services/templateEngine.js
 *
 * Replace {{ColumnName}} placeholders in a string with row values.
 * - Case-insensitive match against column headers
 * - Missing keys → replaced with empty string, logged as warning
 * - Returns the merged string
 */

// Regex: matches {{AnyWord}} or {{Any Words With Spaces}}
const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;

/**
 * Build a lookup map from column headers (original case) to their values.
 * Keys are lower-cased for case-insensitive matching.
 *
 * @param {object} row  Row object with original-case keys
 * @returns {Map<string, string>}  Map of lower-case key → value
 */
function buildLookup(row) {
  const map = new Map();
  for (const [k, v] of Object.entries(row)) {
    map.set(String(k).trim().toLowerCase(), v != null ? String(v) : '');
  }
  return map;
}

/**
 * Merge a template string with a data row.
 * All {{PlaceholderName}} occurrences are replaced with the matching column value.
 * Unknown placeholders are replaced with '' and a warning is logged.
 *
 * @param {string} template   Template string (may contain HTML)
 * @param {object} row        Data row (column → value)
 * @param {string} [context]  Optional label for warning messages (e.g. 'subject')
 * @returns {string}          Merged string
 */
function merge(template, row, context) {
  if (!template) return '';
  const lookup = buildLookup(row);
  const warnings = [];

  const result = template.replace(PLACEHOLDER_REGEX, (_match, key) => {
    const normKey = key.trim().toLowerCase();
    if (lookup.has(normKey)) {
      return lookup.get(normKey);
    }
    warnings.push(`Unknown placeholder {{${key}}}${context ? ` in ${context}` : ''}`);
    return '';
  });

  if (warnings.length > 0) {
    console.warn('[templateEngine]', warnings.join(' | '));
  }

  return result;
}

/**
 * Extract all placeholder names used in a template string.
 * Useful for building the placeholder chip list in the UI.
 *
 * @param {string} template
 * @returns {string[]}  Array of placeholder names (original case, de-duplicated)
 */
function extractPlaceholders(template) {
  if (!template) return [];
  const found = new Set();
  let match;
  const re = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  while ((match = re.exec(template)) !== null) {
    found.add(match[1].trim());
  }
  return Array.from(found);
}

/**
 * Strip HTML tags from a string (plain-text fallback).
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

module.exports = { merge, extractPlaceholders, stripHtml };
