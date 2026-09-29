'use strict';

/**
 * services/mailSender.js
 *
 * Send a single email via the configured nodemailer transporter.
 *
 * Inputs: { from, to, subject, html, attachmentPath }
 * Returns: { success: boolean, messageId?: string, error?: string }
 *
 * If attachmentPath is null/undefined the mail is sent without attachment.
 * Errors are caught and returned — never thrown — so the job processor
 * can mark the row as failed without crashing the batch.
 */

const { transporter } = require('../config/mailer');
const path = require('path');
const fs   = require('fs');

/**
 * Normalise Quill-generated HTML for email clients.
 *
 * Problem: Quill wraps each paragraph in <p> tags. Email clients
 * render <p> with a default top AND bottom margin, so 1 Enter press
 * in the editor becomes visually 2 lines of space in the inbox.
 *
 * Fix: inline margin:0 0 0.8em 0 on every <p> so only the bottom
 * gap is applied — exactly matching what the user sees in the editor.
 *
 * @param {string} html  Raw HTML from Quill
 * @returns {string}     Email-safe HTML
 */
function normaliseHtml(html) {
  if (!html) return '';
  return html
    // Remove top margin on <p> tags — keep a single bottom gap only
    .replace(/<p(\s|>)/gi, (match, rest) => {
      if (rest.startsWith(' style="') || rest.startsWith(" style='")) {
        // Already has a style attr — prepend our rule
        return `<p${rest.replace(/style=["']/, 'style="margin:0 0 0.8em 0;')}`;
      }
      return `<p style="margin:0 0 0.8em 0;"${rest}`;
    })
    // Zero out top margin on headings too
    .replace(/<(h[1-6])(\s|>)/gi, (match, tag, rest) => `<${tag} style="margin-top:0;"${rest}`);
}

/**
 * Send a single personalised email.
 *
 * @param {object} options
 * @param {string}        options.from               Sender address
 * @param {string}        options.to                 Recipient address (To field)
 * @param {string}        [options.cc]               CC addresses (comma-separated or array)
 * @param {string}        [options.bcc]              BCC addresses (comma-separated or array)
 * @param {string}        options.subject            Merged subject line
 * @param {string}        options.html               Merged HTML body (Quill output)
 * @param {string[]}      [options.attachmentPaths]  Array of resolved absolute paths
 * @param {string|null}   [options.attachmentPath]   Legacy single path (still accepted)
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendMail({ from, to, cc, bcc, subject, html, attachmentPaths, attachmentPath }) {
  // Normalise to array — support both old single-path callers and new multi-path callers
  const allPaths = attachmentPaths && attachmentPaths.length
    ? attachmentPaths
    : (attachmentPath ? [attachmentPath] : []);

  const mailOptions = {
    from,
    to,
    subject,
    html: normaliseHtml(html),
    text: html ? html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '',
  };

  if (cc)  mailOptions.cc  = cc;
  if (bcc) mailOptions.bcc = bcc;

  // Build attachments array from all resolved paths
  if (allPaths.length > 0) {
    const attachments = [];
    for (const p of allPaths) {
      if (!fs.existsSync(p)) {
        return { success: false, error: `Attachment not found: ${p}` };
      }
      attachments.push({ filename: path.basename(p), path: p });
    }
    mailOptions.attachments = attachments;
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[mailSender] Sent to ${to} — messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailSender] Failed to send to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendMail };
