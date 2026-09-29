'use strict';

/**
 * scripts/hash-password.js
 * Generate a bcrypt hash for the LOCAL_ADMIN_PASS_HASH env variable.
 *
 * Usage:
 *   node scripts/hash-password.js MyNewPassword123
 *
 * Then paste the output into your .env as LOCAL_ADMIN_PASS_HASH=<hash>
 */

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

console.log('\n✅ Bcrypt hash generated (cost factor 12):\n');
console.log(hash);
console.log('\nPaste this into your .env file as:');
console.log(`LOCAL_ADMIN_PASS_HASH=${hash}\n`);
