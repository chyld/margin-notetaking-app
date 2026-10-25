'use strict';

// Password hashing (scrypt) and stateless signed session tokens.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DATA_DIR, USERNAME_RE } = require('./store');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SECRET_FILE = path.join(DATA_DIR, 'session_secret');

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_PARAMS);
  return { salt: salt.toString('hex'), hash: key.toString('hex'), ...SCRYPT_PARAMS };
}

// Used when the username doesn't exist, so the response takes as long as a real check.
const DUMMY_RECORD = {
  salt: crypto.randomBytes(16).toString('hex'),
  hash: '00'.repeat(SCRYPT_PARAMS.keylen),
  ...SCRYPT_PARAMS,
};

async function verifyPassword(password, record) {
  const rec = record || DUMMY_RECORD;
  const key = await scrypt(password, Buffer.from(rec.salt, 'hex'), rec);
  const expected = Buffer.from(rec.hash, 'hex');
  const match = key.length === expected.length && crypto.timingSafeEqual(key, expected);
  return Boolean(record) && match;
}

// The signing secret is generated on first start and kept in the data directory,
// so there is no environment variable to forget (an empty key would be forgeable).
async function loadSessionSecret() {
  try {
    const secret = (await fsp.readFile(SECRET_FILE, 'utf8')).trim();
    if (!/^[0-9a-f]{64,}$/.test(secret)) throw new Error(`${SECRET_FILE} is malformed; delete it to regenerate`);
    return Buffer.from(secret, 'hex');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    await fsp.writeFile(SECRET_FILE, secret + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') return loadSessionSecret();
    throw err;
  }
  return Buffer.from(secret, 'hex');
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

// Token: <username>.<expiry unix seconds>.<HMAC-SHA256(secret, "<username>.<expiry>")>
function createToken(secret, username) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${username}.${expiry}`;
  return `${payload}.${sign(secret, payload)}`;
}

// Returns the username if the token is valid and unexpired, otherwise null.
function verifyToken(secret, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [username, expiryStr, mac] = parts;
  if (!USERNAME_RE.test(username) || !/^\d{1,12}$/.test(expiryStr)) return null;
  // No upper bound: the MAC already covers the expiry, and a bound would log
  // everyone out if the clock stepped backwards.
  if (Number(expiryStr) <= Math.floor(Date.now() / 1000)) return null;
  const expected = Buffer.from(sign(secret, `${username}.${expiryStr}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return username;
}

module.exports = {
  SESSION_TTL_SECONDS,
  hashPassword,
  verifyPassword,
  loadSessionSecret,
  createToken,
  verifyToken,
};
