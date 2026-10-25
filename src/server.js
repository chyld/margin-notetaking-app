'use strict';

process.umask(0o077);

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const store = require('./store');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 5555;
const COOKIE_NAME = 'margin_session';
const NOTE_BODY_LIMIT = 1024 * 1024;
const LOGIN_BODY_LIMIT = 4096;
const TAGS_BODY_LIMIT = 4096;
const PASSWORD_MAX_BYTES = 1024;
const LOGIN_MAX_PER_ACCOUNT = 5; // failed attempts per IP + username
const LOGIN_MAX_PER_IP = 20; // failed attempts per IP, across all usernames
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_CHECKS = 8; // concurrent scrypt verifications, server-wide
const WRITER_RE = /^[0-9a-f]{32}$/;
const SEQ_RE = /^\d{1,15}$/;

// Only these files are served; no URL is ever mapped onto the filesystem.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
  '/favicon.ico': { file: 'favicon.ico', type: 'image/x-icon' },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' },
};
for (const entry of Object.values(STATIC_FILES)) {
  entry.body = fs.readFileSync(path.join(PUBLIC_DIR, entry.file));
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
};

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function methodNotAllowed(allow) {
  return new HttpError(405, 'Method not allowed', { Allow: allow });
}

let sessionSecret;

// ---- helpers -----------------------------------------------------------

function send(res, status, body, headers = {}) {
  const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(buf ? { 'Content-Length': buf.length } : {}),
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) return Promise.reject(new HttpError(413, 'Request body too large'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}

function requireType(req, type) {
  const header = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (header !== type) throw new HttpError(415, `Content-Type must be ${type}`);
}

// Rejects state-changing requests that a browser marks as coming from another site.
function requireSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
  }
}

function parseCookies(header) {
  const cookies = Object.create(null);
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;
}

// Resolves the logged-in user, re-checking that they still exist in users.json.
// An invalid session also clears the cookie.
async function requireUser(req) {
  const notLoggedIn = () => new HttpError(401, 'Not logged in', { 'Set-Cookie': sessionCookie('', 0) });
  const username = auth.verifyToken(sessionSecret, parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (!username) throw notLoggedIn();
  const users = await store.readUsers();
  if (!users.has(username)) throw notLoggedIn();
  return username;
}

// ---- login throttling ----------------------------------------------------

// Each attempt is counted as soon as it starts, so parallel attempts can't slip
// past the limit. A successful attempt refunds only its own count; earlier
// failures stay until the window expires.
const loginAttempts = new Map(); // key -> { count, first }
let passwordChecks = 0;

function reserveLoginAttempt(ip, username) {
  const now = Date.now();
  const limits = [
    [`ip\0${ip}`, LOGIN_MAX_PER_IP],
    [`account\0${ip}\0${username}`, LOGIN_MAX_PER_ACCOUNT],
  ];
  for (const [key, max] of limits) {
    const entry = loginAttempts.get(key);
    if (entry && now - entry.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
    else if (entry && entry.count >= max) {
      const wait = Math.ceil((entry.first + LOGIN_WINDOW_MS - now) / 1000);
      throw new HttpError(429, 'Too many failed attempts. Try again later.', { 'Retry-After': String(wait) });
    }
  }
  const keys = limits.map(([key]) => key);
  for (const key of keys) {
    const entry = loginAttempts.get(key);
    if (entry) entry.count += 1;
    else loginAttempts.set(key, { count: 1, first: now });
  }
  return keys;
}

function refundLoginAttempt(keys) {
  for (const key of keys) {
    const entry = loginAttempts.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, 60 * 1000).unref();

// ---- API -----------------------------------------------------------------

async function login(req, res) {
  requireSameOrigin(req);
  requireType(req, 'application/json');
  let creds;
  try {
    creds = JSON.parse((await readBody(req, LOGIN_BODY_LIMIT)).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON');
  }
  const { username, password } = creds || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'username and password are required');
  }
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) throw new HttpError(400, 'Password too long');

  if (passwordChecks >= MAX_PASSWORD_CHECKS) {
    throw new HttpError(503, 'Server busy. Try again in a moment.', { 'Retry-After': '1' });
  }
  const attemptKeys = reserveLoginAttempt(req.socket.remoteAddress, username);
  passwordChecks += 1;
  let ok;
  try {
    const users = await store.readUsers();
    const record = store.USERNAME_RE.test(username) ? users.get(username) : undefined;
    ok = await auth.verifyPassword(password, record);
  } finally {
    passwordChecks -= 1;
  }
  if (!ok) throw new HttpError(401, 'Invalid username or password');
  refundLoginAttempt(attemptKeys);
  await store.ensureUserDir(username);
  const token = auth.createToken(sessionSecret, username);
  sendJson(res, 200, { username }, { 'Set-Cookie': sessionCookie(token, auth.SESSION_TTL_SECONDS) });
}

function logout(req, res) {
  requireSameOrigin(req);
  send(res, 204, undefined, { 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store' });
}

// Optional save ordering from the browser: a random id per tab and a number
// that increases with every save from that tab.
function saveOrder(req) {
  const writer = req.headers['x-margin-writer'];
  const seq = req.headers['x-margin-seq'];
  if (writer === undefined && seq === undefined) return {};
  if (!WRITER_RE.test(writer || '') || !SEQ_RE.test(seq || '')) throw new HttpError(400, 'Invalid save order headers');
  return { writer, seq: Number(seq) };
}

function hasBody(req) {
  return req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0;
}

// Reads a JSON object body and returns its `tags`, validated and normalized.
// `required` false means a missing `tags` key is an empty list.
async function readTagsBody(req, { required }) {
  requireType(req, 'application/json');
  let body;
  try {
    body = JSON.parse((await readBody(req, TAGS_BODY_LIMIT)).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  if (body.tags === undefined && !required) return [];
  if (body.tags === undefined) throw new HttpError(400, 'tags is required');
  try {
    return store.normalizeTags(body.tags);
  } catch (err) {
    if (err instanceof store.InvalidTags) throw new HttpError(400, err.message);
    throw err;
  }
}

async function notes(req, res, id, sub) {
  if (req.method !== 'GET') requireSameOrigin(req);
  const username = await requireUser(req);

  if (id === null) {
    if (req.method === 'GET') return sendJson(res, 200, await store.listNotes(username));
    if (req.method === 'POST') {
      // Tags are validated before anything is created.
      const tags = hasBody(req) ? await readTagsBody(req, { required: false }) : [];
      return sendJson(res, 201, await store.createNote(username, tags));
    }
    throw methodNotAllowed('GET, POST');
  }

  if (!store.isNoteId(id)) throw new HttpError(404, 'Note not found');

  if (sub === 'tags') {
    if (req.method !== 'PUT') throw methodNotAllowed('PUT');
    const order = saveOrder(req);
    const tags = await readTagsBody(req, { required: true });
    try {
      return sendJson(res, 200, await store.writeTags(username, id, tags, order));
    } catch (err) {
      if (err instanceof store.NotFound) throw new HttpError(404, 'Note not found');
      throw err;
    }
  }
  if (sub !== null) throw new HttpError(404, 'Not found');

  try {
    if (req.method === 'GET') {
      const text = await store.readNote(username, id);
      return send(res, 200, text, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (req.method === 'PUT') {
      requireType(req, 'text/plain');
      const order = saveOrder(req);
      const body = await readBody(req, NOTE_BODY_LIMIT);
      return sendJson(res, 200, await store.writeNote(username, id, body.toString('utf8'), order));
    }
  } catch (err) {
    if (err instanceof store.NotFound) throw new HttpError(404, 'Note not found');
    throw err;
  }
  throw methodNotAllowed('GET, PUT');
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  const asset = STATIC_FILES[pathname];
  if (asset) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': asset.type,
      'Content-Length': asset.body.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(req.method === 'HEAD' ? undefined : asset.body);
  }

  if (pathname === '/api/login') {
    if (req.method !== 'POST') throw methodNotAllowed('POST');
    return login(req, res);
  }
  if (pathname === '/api/logout') {
    if (req.method !== 'POST') throw methodNotAllowed('POST');
    return logout(req, res);
  }
  if (pathname === '/api/notes') return notes(req, res, null, null);
  if (pathname.startsWith('/api/notes/')) {
    // /api/notes/<id> or /api/notes/<id>/tags; anything deeper is a 404.
    const [id, sub = null, ...rest] = pathname.slice('/api/notes/'.length).split('/');
    if (rest.length > 0) throw new HttpError(404, 'Not found');
    return notes(req, res, id, sub);
  }

  throw new HttpError(404, 'Not found');
}

// ---- startup -------------------------------------------------------------

async function main() {
  try {
    await fsp.mkdir(store.NOTES_DIR, { recursive: true, mode: 0o700 });
    await fsp.access(store.DATA_DIR, fs.constants.W_OK);
  } catch (err) {
    console.error(
      `Cannot write to ${store.DATA_DIR} (${err.code}). Make sure ./data exists on the host and is owned ` +
        'by the user the container runs as (MARGIN_UID/MARGIN_GID, default 1000:1000).',
    );
    process.exit(1);
  }
  await store.sweepTempFiles();
  sessionSecret = await auth.loadSessionSecret();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      const headers = { ...err.headers };
      // Stop reading an oversized body; the connection is closed after the reply.
      if (status === 413) headers.Connection = 'close';
      sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message }, headers);
    });
  });
  server.listen(PORT, '0.0.0.0', () => console.log(`Margin listening on port ${PORT}`));

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
