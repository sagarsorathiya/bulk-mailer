'use strict';

/**
 * config/ldap.js
 *
 * LDAP / Active Directory authentication helper.
 *
 * Flow:
 *   1. Bind as service account (LDAP_BIND_DN) to search for the user's DN
 *   2. Bind as the user DN with their supplied password to verify credentials
 *   3. Check membership in BulkMailer-Users group
 *   4. Return { username, displayName, department } on success
 *
 * Returns null (not throws) on auth failure so routes can return 401 cleanly.
 */

require('dotenv').config();
const ldap = require('ldapjs');

const LDAP_URL       = process.env.LDAP_URL       || '';
const LDAP_BASE_DN   = process.env.LDAP_BASE_DN   || '';
const LDAP_BIND_DN  = process.env.LDAP_BIND_DN   || '';
const LDAP_BIND_PASS = process.env.LDAP_BIND_PASS || '';

// AD group that must contain the user
const REQUIRED_GROUP_CN = process.env.LDAP_REQUIRED_GROUP || 'BulkMailer-Users';

/**
 * Escape a value for safe use inside an LDAP search filter.
 * RFC 4515 §3: special chars are: \ * ( ) NUL
 * ldapjs's escapeDN() is for DN values only — do NOT use it for filters.
 */
function escapeLdapFilter(value) {
  return String(value)
    .replace(/\\/g,  '\\5c')
    .replace(/\*/g,  '\\2a')
    .replace(/\(/g,  '\\28')
    .replace(/\)/g,  '\\29')
    .replace(/\x00/g,'\\00');
}

/**
 * Create a new LDAP client and bind with the given DN + password.
 * Returns the bound client on success, or throws on failure.
 *
 * @param {string} dn
 * @param {string} password
 * @returns {Promise<ldap.Client>}
 */
function createAndBind(dn, password) {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({
      url:            LDAP_URL,
      reconnect:      false,
      connectTimeout: 8000,
      timeout:        10000,
    });

    client.on('error', (err) => {
      reject(new Error(`LDAP connection error: ${err.message}`));
    });

    client.bind(dn, password, (err) => {
      if (err) {
        client.destroy();
        reject(err);
      } else {
        resolve(client);
      }
    });
  });
}

/**
 * Search LDAP for a single user entry by sAMAccountName.
 *
 * @param {ldap.Client} client  Bound LDAP client
 * @param {string}      username  sAMAccountName (login name)
 * @returns {Promise<object|null>}  LDAP entry object or null if not found
 */
function findUser(client, username) {
  return new Promise((resolve, reject) => {
    const opts = {
      scope:  'sub',
      filter: `(sAMAccountName=${escapeLdapFilter(username)})`,
      attributes: ['dn', 'displayName', 'department', 'memberOf', 'sAMAccountName', 'mail'],
    };

    const entries = [];

    client.search(LDAP_BASE_DN, opts, (err, res) => {
      if (err) return reject(err);

      res.on('searchEntry', (entry) => entries.push(entry));
      res.on('error', reject);
      res.on('end', () => resolve(entries[0] || null));
    });
  });
}

/**
 * Check if a memberOf array contains the required group CN.
 *
 * @param {string|string[]} memberOf  LDAP memberOf attribute value(s)
 * @returns {boolean}
 */
function isInRequiredGroup(memberOf) {
  const groups = Array.isArray(memberOf) ? memberOf : [memberOf].filter(Boolean);
  return groups.some((dn) => {
    // dn = "CN=BulkMailer-Users,OU=Groups,DC=example,DC=com"
    const cnMatch = String(dn).match(/^CN=([^,]+)/i);
    return cnMatch && cnMatch[1] === REQUIRED_GROUP_CN;
  });
}

/**
 * Authenticate a user against Active Directory.
 *
 * @param {string} username  sAMAccountName
 * @param {string} password  User's AD password
 * @returns {Promise<{ username: string, displayName: string, department: string }|null>}
 *          Returns null on auth failure (wrong password, not in group, user not found).
 *          Throws on unexpected LDAP errors (connection, etc.)
 */
async function authenticate(username, password) {
  let serviceClient = null;
  let userClient    = null;

  try {
    // Step 1: Bind as service account to search for user DN
    serviceClient = await createAndBind(LDAP_BIND_DN, LDAP_BIND_PASS);

    const entry = await findUser(serviceClient, username);
    if (!entry) {
      console.warn(`[ldap] User not found: ${username}`);
      return null;
    }

    const userDn      = entry.dn.toString();
    const displayName = entry.object.displayName  || username;
    const department  = entry.object.department   || '';
    const memberOf    = entry.object.memberOf;

    // Step 2: Check group membership before binding as user
    if (!isInRequiredGroup(memberOf)) {
      console.warn(`[ldap] User ${username} is not in ${REQUIRED_GROUP_CN}`);
      return null;
    }

    // Step 3: Bind as user to verify password
    userClient = await createAndBind(userDn, password);

    console.log(`[ldap] Authenticated: ${username} (${department})`);
    return { username, displayName, department };

  } catch (err) {
    // Invalid credentials from AD → err.name === 'InvalidCredentialsError'
    if (err.name === 'InvalidCredentialsError') {
      console.warn(`[ldap] Invalid credentials for: ${username}`);
      return null;
    }
    // Other errors (network, config) bubble up
    throw err;
  } finally {
    if (serviceClient) try { serviceClient.destroy(); } catch (_) {}
    if (userClient)    try { userClient.destroy();    } catch (_) {}
  }
}

module.exports = { authenticate };
