'use strict';

/**
 * routes/auth.js
 *
 * POST /api/auth/login   — Authenticate: local superadmin first, then LDAP
 * POST /api/auth/logout  — Destroy session
 * GET  /api/auth/me      — Return current user info
 */

const router           = require('express').Router();
const bcrypt           = require('bcryptjs');
const { authenticate } = require('../config/ldap');
const { query }        = require('../config/db');

// ──────────────────────────────────────────────
// Local superadmin check (from .env, bypasses LDAP)
// ──────────────────────────────────────────────

/**
 * Attempt to authenticate against the local superadmin defined in .env.
 * Returns user object on match, null otherwise.
 *
 * @param {string} username
 * @param {string} password
 * @returns {{ username, displayName, department, isLocalAdmin: true } | null}
 */
function checkLocalAdmin(username, password) {
  const adminUser = process.env.LOCAL_ADMIN_USER;
  const adminHash = process.env.LOCAL_ADMIN_PASS_HASH;

  if (!adminUser || !adminHash) return null;  // not configured
  if (username.toLowerCase() !== adminUser.toLowerCase()) return null;

  const valid = bcrypt.compareSync(password, adminHash);
  if (!valid) return null;

  return {
    username:     adminUser,
    displayName:  process.env.LOCAL_ADMIN_DISPLAY_NAME || 'Local Admin',
    department:   process.env.LOCAL_ADMIN_DEPARTMENT   || 'Admin',
    isLocalAdmin: true,
  };
}

// ──────────────────────────────────────────────
// POST /api/auth/login
// ──────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required.' });
    }

    const trimmedUser = String(username).trim();
    let user = null;

    // ── Step 1: Check local superadmin first (works offline, no LDAP needed) ──
    user = checkLocalAdmin(trimmedUser, String(password));

    if (user) {
      console.log(`[auth] Local admin login: ${user.username}`);
    } else {
      // ── Step 2: Fall through to LDAP ──
      user = await authenticate(trimmedUser, String(password));
    }

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials or access not permitted.' });
    }

    // Upsert user record in local DB (audit trail)
    await query(
      `INSERT INTO users (username, display_name, department)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             department   = EXCLUDED.department`,
      [user.username, user.displayName, user.department]
    );

    // Store in session
    req.session.user = {
      username:     user.username,
      displayName:  user.displayName,
      department:   user.department,
      isLocalAdmin: user.isLocalAdmin || false,
    };

    return res.json({ success: true, user: req.session.user });

  } catch (err) {
    console.error('[auth/login]', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Authentication service error. Please try again.' });
  }
});

// ──────────────────────────────────────────────
// POST /api/auth/logout
// ──────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[auth/logout] session destroy error:', err.message);
    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

// ──────────────────────────────────────────────
// GET /api/auth/me
// ──────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated.' });
  }
  return res.json({ success: true, user: req.session.user });
});

module.exports = router;
