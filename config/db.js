'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'bulkmailer',
  user:     process.env.DB_USER     || 'bulkmailer',
  password: process.env.DB_PASS     || 'changeme',
  // Keep connections alive for long-running processes
  max:                20,
  idleTimeoutMillis:  30000,
  connectionTimeoutMillis: 5000,
});

// Log pool errors without crashing the process
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Execute a single query with optional values.
 * @param {string} text   SQL string
 * @param {Array}  params Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[DB] query (${duration}ms):`, text.slice(0, 80));
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nSQL:', text);
    throw err;
  }
}

/**
 * Get a dedicated client from the pool for transactions.
 * Caller is responsible for calling client.release().
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

module.exports = { pool, query, getClient };
