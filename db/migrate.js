'use strict';

/**
 * db/migrate.js
 * Runs all .sql files in db/migrations/ in alphabetical order.
 * Tracks executed migrations in a schema_migrations table.
 * Usage: node db/migrate.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
  return new Set(result.rows.map((r) => r.filename));
}

async function applyMigration(client, filename, sql) {
  console.log(`[migrate] Applying: ${filename}`);
  await client.query(sql);
  await client.query(
    'INSERT INTO schema_migrations (filename) VALUES ($1)',
    [filename]
  );
  console.log(`[migrate] Done:     ${filename}`);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);

    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] Already applied: ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await applyMigration(client, file, sql);
      ran++;
    }

    await client.query('COMMIT');

    if (ran === 0) {
      console.log('[migrate] No new migrations to apply.');
    } else {
      console.log(`[migrate] Applied ${ran} migration(s) successfully.`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] Migration failed — rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
