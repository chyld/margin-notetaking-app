'use strict';

// File-based storage: users.json plus one plain-text file per note.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const NOTES_DIR = path.join(DATA_DIR, 'notes');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USERS_LOCK = path.join(DATA_DIR, 'users.lock');

const USERNAME_RE = /^[a-z0-9_-]{1,32}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const NOTE_ID_RE = new RegExp(`^${UUID}$`);
const NOTE_FILE_RE = new RegExp(`^(${UUID})\\.txt$`);
const TMP_FILE_RE = /\.tmp-[0-9a-f]{12}$/;

const LABEL_BYTES = 4096;
const LABEL_CHARS = 80;
const LOCK_TIMEOUT_MS = 5_000;
const SEQ_TTL_MS = 24 * 60 * 60 * 1000;

const OPEN_NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

class NotFound extends Error {}

async function syncDir(dir) {
  const fh = await fsp.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Write to a private temp file in the same directory, fsync it, then rename it
// over the target, so readers only ever see the old or the new contents.
async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  const fh = await fsp.open(tmp, 'wx', 0o600);
  try {
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    // Don't leave a partial temp file behind (e.g. disk full), or retries pile them up.
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await syncDir(dir);
}

// Remove temp files left behind by a crash mid-write.
async function sweepTempFiles() {
  const dirs = [DATA_DIR];
  for (const name of await fsp.readdir(NOTES_DIR).catch(() => [])) {
    if (USERNAME_RE.test(name)) dirs.push(path.join(NOTES_DIR, name));
  }
  for (const dir of dirs) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (TMP_FILE_RE.test(name)) await fsp.rm(path.join(dir, name), { force: true });
    }
  }
}

// ---- users -------------------------------------------------------------

// Returns a Map so usernames like "__proto__" can't collide with Object.prototype.
async function readUsers() {
  let raw;
  try {
    raw = await fsp.readFile(USERS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${USERS_FILE} is malformed`);
  }
  return new Map(Object.entries(parsed));
}

async function writeUsers(users) {
  await writeFileAtomic(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 2) + '\n');
}

// Serializes read-modify-write of users.json across processes (CLI runs).
// The lock is never taken over automatically: two processes could both decide
// it is stale and both proceed. If a run was killed while holding it, the error
// says how to clear it.
async function withUsersLock(fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fsp.mkdir(USERS_LOCK, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `${USERS_LOCK} is held by another create-user run. If none is running, remove data/users.lock and retry.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(USERS_LOCK, { recursive: true, force: true });
  }
}

// ---- notes -------------------------------------------------------------

function userDir(username) {
  if (!USERNAME_RE.test(username)) throw new Error('invalid username');
  return path.join(NOTES_DIR, username);
}

function isNoteId(id) {
  return NOTE_ID_RE.test(id);
}

function notePath(username, id) {
  if (!isNoteId(id)) throw new NotFound();
  return path.join(userDir(username), `${id}.txt`);
}

async function ensureUserDir(username) {
  await fsp.mkdir(userDir(username), { recursive: true, mode: 0o700 });
}

// The label always comes from the first LABEL_BYTES of the file, so the list
// and the response to a save agree. StringDecoder drops a trailing partial
// UTF-8 character instead of producing U+FFFD.
function makeLabel(buf) {
  const text = new StringDecoder('utf8').write(buf);
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '');
  return line ? line.trim().slice(0, LABEL_CHARS) : 'Untitled';
}

// Opens a note without following symlinks; returns null if it isn't a regular file.
async function openNote(file) {
  let fh;
  try {
    fh = await fsp.open(file, OPEN_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP') return null;
    throw err;
  }
  const st = await fh.stat();
  if (!st.isFile()) {
    await fh.close();
    return null;
  }
  return { fh, st };
}

// Reads a note's list entry, or returns null if it isn't a regular file.
async function noteMeta(file, id) {
  const opened = await openNote(file);
  if (!opened) return null;
  const { fh, st } = opened;
  try {
    // Only the start of the file is needed for the label.
    const buf = Buffer.alloc(Math.min(LABEL_BYTES, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { id, label: makeLabel(buf.subarray(0, bytesRead)), mtime: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

async function listNotes(username) {
  const dir = userDir(username);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const notes = [];
  for (const name of names) {
    const match = NOTE_FILE_RE.exec(name);
    if (!match) continue;
    const meta = await noteMeta(path.join(dir, name), match[1]);
    if (meta) notes.push(meta);
  }
  notes.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return notes;
}

async function createNote(username) {
  await ensureUserDir(username);
  const id = crypto.randomUUID();
  const file = notePath(username, id);
  await fsp.writeFile(file, '', { flag: 'wx', mode: 0o600 });
  await syncDir(path.dirname(file));
  const st = await fsp.stat(file);
  return { id, label: makeLabel(Buffer.alloc(0)), mtime: st.mtimeMs };
}

async function readNote(username, id) {
  const opened = await openNote(notePath(username, id));
  if (!opened) throw new NotFound();
  const { fh } = opened;
  try {
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

// Writes to the same note run one at a time, in the order they arrive.
const noteLocks = new Map(); // file -> tail of the queue

async function withNoteLock(file, fn) {
  const prev = noteLocks.get(file) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => (release = resolve));
  const tail = prev.then(() => mine);
  noteLocks.set(file, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (noteLocks.get(file) === tail) noteLocks.delete(file);
  }
}

// Highest save number applied per (note, browser tab). A tab numbers its saves,
// so if an older save from the same tab arrives after a newer one it is skipped.
// Saves from different tabs aren't compared: the most recent one wins.
const lastSeq = new Map(); // `${file}\0${writer}` -> { seq, at }

setInterval(() => {
  const cutoff = Date.now() - SEQ_TTL_MS;
  for (const [key, entry] of lastSeq) {
    if (entry.at < cutoff) lastSeq.delete(key);
  }
}, 60 * 60 * 1000).unref();

// Overwrites an existing note. Notes are only ever created by createNote.
// Returns the note's list entry, with `stale: true` if the write was skipped.
async function writeNote(username, id, text, { writer, seq } = {}) {
  const file = notePath(username, id);
  return withNoteLock(file, async () => {
    const st = await fsp.lstat(file).catch(() => null);
    if (!st || !st.isFile()) throw new NotFound();
    const key = writer && `${file}\0${writer}`;
    if (key) {
      const last = lastSeq.get(key);
      if (last && seq <= last.seq) return { ...(await noteMeta(file, id)), stale: true };
    }
    await writeFileAtomic(file, text);
    // Only a save that was actually written counts, so a failed one can be retried.
    if (key) lastSeq.set(key, { seq, at: Date.now() });
    const meta = await noteMeta(file, id);
    if (!meta) throw new NotFound();
    return meta;
  });
}

module.exports = {
  DATA_DIR,
  NOTES_DIR,
  USERNAME_RE,
  NotFound,
  isNoteId,
  writeFileAtomic,
  sweepTempFiles,
  readUsers,
  writeUsers,
  withUsersLock,
  ensureUserDir,
  listNotes,
  createNote,
  readNote,
  writeNote,
};
