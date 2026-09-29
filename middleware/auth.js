'use strict';

/**
 * middleware/auth.js
 *
 * Session-based authentication middleware.
 * Reads req.session.user — set by routes/auth.js on successful login.
 *
 * requireAuth:    Returns 401 if not logged in, attaches req.user
 * requireAdmin:   Returns 403 if user is not in Admin department
 */

/**
 * Middleware: require authenticated session.
 * Attaches req.user = { username, displayName, department }
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  req.user = req.session.user;
  next();
}

/**
 * Middleware: require Admin department.
 * Must be used after requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.department !== 'Admin') {
    return res.status(403).json({ success: false, error: 'Admin access required.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
