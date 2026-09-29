'use strict';
// config/allowedSenders.js — Allowlist of from-addresses per department
// Admins can send from any address; regular users restricted to their department's list

module.exports = {
  HR:      ['hr@example.com'],
  Finance: ['finance@example.com', 'accounts@example.com'],
  Admin:   ['admin@example.com'],
  IT:      ['it@example.com'],
};
