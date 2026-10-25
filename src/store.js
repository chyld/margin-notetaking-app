'use strict';

// File-based storage: users.json, plus per note a plain-text file and an
// optional JSON sidecar holding its tags.

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
const SIDECAR_FILE_RE = new RegExp(`^(${UUID})\\.json$`);
const TMP_FILE_RE = /\.tmp-[0-9a-f]{12}$/;
const TAG_RE = /^[a-z0-9]{1,32}$/;

const TITLE_BYTES = 4096;
const TITLE_CHARS = 80;
const MAX_TAGS = 20;
const SIDECAR_MAX_BYTES = 4096;
const LOCK_TIMEOUT_MS = 5_000;
const SEQ_TTL_MS = 24 * 60 * 60 * 1000;

const OPEN_NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

class NotFound extends Error {}
class InvalidTags extends Error {}

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

// Remove what a crash mid-write can leave behind: temp files, and tag sidecars
// whose note was never created (creating a tagged note writes the sidecar first).
async function sweepTempFiles() {
  const dirs = [DATA_DIR];
  for (const name of await fsp.readdir(NOTES_DIR).catch(() => [])) {
    if (USERNAME_RE.test(name)) dirs.push(path.join(NOTES_DIR, name));
  }
  for (const dir of dirs) {
    const names = await fsp.readdir(dir).catch(() => []);
    const present = new Set(names);
    for (const name of names) {
      const sidecar = SIDECAR_FILE_RE.exec(name);
      const orphan = dir !== DATA_DIR && sidecar && !present.has(`${sidecar[1]}.txt`);
      if (TMP_FILE_RE.test(name) || orphan) await fsp.rm(path.join(dir, name), { force: true });
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

function sidecarPath(username, id) {
  if (!isNoteId(id)) throw new NotFound();
  return path.join(userDir(username), `${id}.json`);
}

// The title is the first line of the first TITLE_BYTES of the file, so the list
// and the response to a save agree. StringDecoder drops a trailing partial
// UTF-8 character instead of producing U+FFFD; the cut counts code points so a
// character is never split.
function makeTitle(buf) {
  const text = new StringDecoder('utf8').write(buf);
  const line = text.split('\n', 1)[0].replace(/\r$/, '').trim();
  return line ? [...line].slice(0, TITLE_CHARS).join('') : 'Untitled';
}

// Validates a tag list from a request: an array of valid tags, at most
// MAX_TAGS after de-duplication. Returns it de-duplicated and sorted.
function normalizeTags(tags) {
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string' && TAG_RE.test(t))) {
    throw new InvalidTags('Tags must be 1-32 characters: lowercase letters and digits only.');
  }
  const unique = [...new Set(tags)].sort();
  if (unique.length > MAX_TAGS) throw new InvalidTags(`A note can have at most ${MAX_TAGS} tags.`);
  return unique;
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

// Reads a note's title and last update, or returns null if it isn't a regular file.
async function noteMeta(file, id) {
  const opened = await openNote(file);
  if (!opened) return null;
  const { fh, st } = opened;
  try {
    // Only the start of the file is needed for the title.
    const buf = Buffer.alloc(Math.min(TITLE_BYTES, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { id, title: makeTitle(buf.subarray(0, bytesRead)), mtime: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

const reportedSidecars = new Set(); // bad sidecars already logged by this process

// Reads a note's tags. A missing sidecar means no tags; an unusable one (not a
// regular file, too big, bad JSON, wrong shape, invalid tag) is logged once and
// also treated as no tags, so it can never stop the note from listing.
async function readTags(file) {
  let problem;
  try {
    const opened = await openNote(file);
    if (!opened) {
      const st = await fsp.lstat(file).catch(() => null);
      if (!st) return [];
      problem = 'not a regular file';
    } else {
      const { fh, st } = opened;
      try {
        if (st.size > SIDECAR_MAX_BYTES) {
          problem = 'too large';
        } else {
          const parsed = JSON.parse(await fh.readFile('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) problem = 'not an object';
          else return normalizeTags(parsed.tags);
        }
      } finally {
        await fh.close();
      }
    }
  } catch (err) {
    problem = err.message;
  }
  if (!reportedSidecars.has(file)) {
    reportedSidecars.add(file);
    console.error(`Ignoring tags in ${file}: ${problem}`);
  }
  return [];
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
    if (meta) notes.push({ ...meta, tags: await readTags(path.join(dir, `${match[1]}.json`)) });
  }
  notes.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return notes;
}

function writeTagsFile(file, tags) {
  return writeFileAtomic(file, JSON.stringify({ tags }) + '\n');
}

// Creates an empty note with the given (already normalized) tags. The sidecar is
// written first and the .txt last, since the .txt is what makes the note exist:
// a crash in between leaves only an invisible sidecar, removed at startup.
async function createNote(username, tags = []) {
  await ensureUserDir(username);
  const id = crypto.randomUUID();
  const file = notePath(username, id);
  const sidecar = sidecarPath(username, id);
  if (tags.length > 0) await writeTagsFile(sidecar, tags);
  try {
    await fsp.writeFile(file, '', { flag: 'wx', mode: 0o600 });
    await syncDir(path.dirname(file));
  } catch (err) {
    await fsp.rm(sidecar, { force: true });
    throw err;
  }
  const st = await fsp.stat(file);
  return { id, title: makeTitle(Buffer.alloc(0)), mtime: st.mtimeMs, tags };
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

// Writes to the same note (its text or its tags) run one at a time, in the
// order they arrive. The lock is keyed by the note's .txt path for both.
const noteLocks = new Map(); // .txt path -> tail of the queue

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

// Highest save number applied per (note, browser tab, kind). A tab numbers its
// saves, so if an older save from the same tab arrives after a newer one it is
// skipped. Text and tag saves are numbered separately. Saves from different
// tabs aren't compared: the most recent one wins.
const lastSeq = new Map(); // `${file}\0${kind}\0${writer}` -> { seq, at }

setInterval(() => {
  const cutoff = Date.now() - SEQ_TTL_MS;
  for (const [key, entry] of lastSeq) {
    if (entry.at < cutoff) lastSeq.delete(key);
  }
}, 60 * 60 * 1000).unref();

// Overwrites an existing note's text. Notes are only ever created by createNote.
// Returns { id, title, mtime }, with `stale: true` if the write was skipped.
async function writeNote(username, id, text, { writer, seq } = {}) {
  const file = notePath(username, id);
  return withNoteLock(file, async () => {
    const st = await fsp.lstat(file).catch(() => null);
    if (!st || !st.isFile()) throw new NotFound();
    const key = writer && `${file}\0text\0${writer}`;
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

// Replaces a note's tags (already normalized). Returns { id, tags }, with
// `stale: true` and the current tags if the write was skipped.
async function writeTags(username, id, tags, { writer, seq } = {}) {
  const file = notePath(username, id);
  const sidecar = sidecarPath(username, id);
  return withNoteLock(file, async () => {
    // Never write a sidecar for a note that doesn't exist.
    const st = await fsp.lstat(file).catch(() => null);
    if (!st || !st.isFile()) throw new NotFound();
    const key = writer && `${file}\0tags\0${writer}`;
    if (key) {
      const last = lastSeq.get(key);
      if (last && seq <= last.seq) return { id, tags: await readTags(sidecar), stale: true };
    }
    await writeTagsFile(sidecar, tags);
    reportedSidecars.delete(sidecar);
    if (key) lastSeq.set(key, { seq, at: Date.now() });
    return { id, tags };
  });
}

module.exports = {
  DATA_DIR,
  NOTES_DIR,
  USERNAME_RE,
  NotFound,
  InvalidTags,
  isNoteId,
  normalizeTags,
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
  writeTags,
};
