'use strict';

/**
 * server.js
 * Bulk Mailer — Express application entry point.
 *
 * Mounts all routes, serves public/, configures session,
 * rate-limits login, and provides a global error handler.
 */

require('dotenv').config();

const express      = require('express');
const path         = require('path');
const session      = require('express-session');
const rateLimit    = require('express-rate-limit');
const fs           = require('fs');

const { pool }            = require('./config/db');
const { verifyConnection } = require('./config/mailer');

// Routes
const authRoutes    = require('./routes/auth');
const jobsRoutes    = require('./routes/jobs');
const previewRoutes = require('./routes/preview');
const logsRoutes    = require('./routes/logs');
const statsRoutes   = require('./routes/stats');

// ── App ──
const app         = express();
const PREFERRED_PORT = parseInt(process.env.PORT || '3000', 10);

/**
 * Check whether a given TCP port is free on localhost.
 * Returns a Promise that resolves true (free) or false (in use).
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const net    = require('net');
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port.
 * Tries PREFERRED_PORT first; if busy, picks random ports in [4000, 9999]
 * until one is free (max 20 attempts).
 */
async function findFreePort() {
  if (await isPortFree(PREFERRED_PORT)) return PREFERRED_PORT;

  console.warn(`[server] Port ${PREFERRED_PORT} is already in use — searching for a free port…`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = Math.floor(Math.random() * (9999 - 4000 + 1)) + 4000;
    if (candidate === PREFERRED_PORT) continue;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error('Could not find a free port after 20 attempts.');
}

// ── Ensure uploads and logs directories exist ──
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'tmp'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });

// ── Trust proxy (for rate limiting behind nginx/IIS) ──
app.set('trust proxy', 1);

// ── Security headers ──
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',      'camera=(), microphone=(), geolocation=()');
  // CSP: allow self + local assets only; unsafe-inline needed for Quill and inline scripts
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self';"
  );
  next();
});

// ── Body parsing ──
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Session ──
app.use(
  session({
    name:              'bm.sid',  // don't leak framework name via default connect.sid
    secret:            process.env.SESSION_SECRET || 'CHANGE-ME-PLEASE',
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   process.env.COOKIE_SECURE === 'true',
      httpOnly: true,
      sameSite: 'strict',
      maxAge:   8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// ── Rate limiters ──
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      5,
  message:  { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: () => process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true',
});

// General API limiter: 200 req / 15 min per IP — stops scraping / runaway loops
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  message:  { success: false, error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: () => process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true',
});

// Stricter limiter for job creation (heavy operation: parses Excel, writes DB rows)
const jobCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      30,
  message:  { success: false, error: 'Too many job creation requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ── Static files (public/) ──
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
}));

// ── API Routes ──
app.use('/api',            apiLimiter);           // blanket API rate limit
app.use('/api/auth/login', loginLimiter);         // stricter login limit
app.use('/api/jobs',       jobCreateLimiter);     // stricter job creation limit (applies to POST /)
app.use('/api/auth',       authRoutes);
app.use('/api/jobs',       jobsRoutes);
app.use('/api/preview',    previewRoutes);
app.use('/api/logs',       logsRoutes);
app.use('/api/stats',      statsRoutes);

// ── Health check (for pm2 / load balancer) ──
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── SPA fallback: serve index.html for non-API routes ──
app.get('*', (req, res) => {
  // Do not intercept API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Not found.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message, err.stack);
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ── Start ──
let httpServer;

async function start() {
  // Verify DB connectivity
  try {
    await pool.query('SELECT 1');
    console.log('[server] PostgreSQL connected');
  } catch (err) {
    console.error('[server] PostgreSQL connection failed:', err.message);
  }

  await verifyConnection();

  const PORT = await findFreePort();

  httpServer = app.listen(PORT, () => {
    console.log('');
    console.log(`  ✅  Bulk Mailer is running`);
    console.log(`  🌐  http://localhost:${PORT}`);
    if (PORT !== PREFERRED_PORT) {
      console.log(`  ⚠️   Port ${PREFERRED_PORT} was busy — using port ${PORT} instead`);
    }
    console.log(`  🔧  NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log('');
  });
}

// ── Graceful shutdown ──
function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  if (httpServer) {
    httpServer.close(() => {
      console.log('[server] HTTP server closed');
      pool.end().catch(() => {}).finally(() => process.exit(0));
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => {
      console.error('[server] Forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

start();

module.exports = app; // for testing
