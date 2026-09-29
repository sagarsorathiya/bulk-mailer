'use strict';

/**
 * config/mailer.js
 * Nodemailer transporter configured for internal SMTP relay (no auth).
 * The relay is on the LAN so TLS/auth are not used.
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || '127.0.0.1',
  port:   parseInt(process.env.SMTP_PORT || '25', 10),
  secure: process.env.SMTP_SECURE === 'true', // false for port 25
  // No auth — internal relay on LAN
  tls: {
    // Allow self-signed certs on internal relay
    rejectUnauthorized: false,
  },
});

/**
 * Verify SMTP connection on startup (non-fatal — logs only).
 */
async function verifyConnection() {
  try {
    await transporter.verify();
    console.log('[mailer] SMTP relay connected:', process.env.SMTP_HOST, 'port', process.env.SMTP_PORT);
  } catch (err) {
    console.warn('[mailer] SMTP relay verification failed (continuing):', err.message);
  }
}

module.exports = { transporter, verifyConnection };
