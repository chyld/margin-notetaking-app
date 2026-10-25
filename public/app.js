'use strict';

const SAVE_DELAY_MS = 500;
const RETRY_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
// Browsers refuse keepalive requests whose bodies total more than 64 KiB.
const KEEPALIVE_MAX_BYTES = 60 * 1024;

const els = {
  loginView: document.getElementById('login-view'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  appView: document.getElementById('app-view'),
  logout: document.getElementById('logout'),
  newNote: document.getElementById('new-note'),
  list: document.getElementById('note-list'),
  text: document.getElementById('note-text'),
  status: document.getElementById('status'),
};

let notes = []; // [{ id, label, mtime }], newest first
let currentId = null;
let savedText = ''; // the current note's text as last confirmed by the server
let saving = false; // a save is in flight; its text isn't confirmed yet
let saveTimer = null;
let saveChain = Promise.resolve(true);
let busy = false; // a switch, create, or logout is in progress

// Every save carries this tab's id and an increasing number, so the server can
// skip an older save from this tab that arrives after a newer one.
const writerId = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
let saveSeq = 0;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Requests time out so a stalled connection can't leave the app stuck.
async function api(method, url, { body, type, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: { ...(type ? { 'Content-Type': type } : {}), ...headers },
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(0, err.name === 'TimeoutError' ? 'the server did not respond' : 'network error');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  }
  return res;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

function showError(err) {
  if (err.status === 401) return showLogin();
  setStatus(err.message || 'Something went wrong.', true);
}

// A save still in flight counts as unsaved: the editor may have been changed
// back to savedText while a different text is being written.
function hasUnsaved() {
  return currentId !== null && (saving || els.text.value !== savedText);
}

// A textarea turns CRLF/CR into LF, so normalize first; otherwise a note with
// CRLF line endings would look edited as soon as it opens.
function openNote(id, rawText) {
  const text = rawText.replace(/\r\n?/g, '\n');
  currentId = id;
  savedText = text;
  els.text.value = text;
  els.text.disabled = false;
  setStatus('');
}

// ---- views ---------------------------------------------------------------

function showLogin(message = '') {
  clearTimeout(saveTimer);
  notes = [];
  currentId = null;
  savedText = '';
  saving = false;
  els.text.value = '';
  els.appView.hidden = true;
  els.loginView.hidden = false;
  els.loginForm.reset();
  els.loginError.textContent = message;
  els.loginForm.elements.username.focus();
}

function showApp(list) {
  notes = list;
  currentId = null;
  savedText = '';
  els.text.value = '';
  els.text.disabled = true;
  els.loginView.hidden = true;
  els.appView.hidden = false;
  setStatus('');
  renderList();
}

function renderList() {
  const items = notes.map((note) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = note.label; // note text is never treated as HTML
    button.title = note.label;
    if (note.id === currentId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => selectNote(note.id));
    li.append(button);
    return li;
  });
  els.list.replaceChildren(...items);
}

function updateNote(meta) {
  notes = notes.filter((n) => n.id !== meta.id);
  notes.push({ id: meta.id, label: meta.label, mtime: meta.mtime });
  notes.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  renderList();
}

// ---- saving --------------------------------------------------------------

// Saves are chained so only one request is in flight at a time and they can
// never arrive out of order. Resolves to false if the save failed.
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveChain = saveChain.then(saveNow);
  return saveChain;
}

async function saveNow() {
  if (!hasUnsaved()) return true;
  const id = currentId;
  const text = els.text.value;
  setStatus('Saving…');
  saving = true;
  try {
    const res = await api('PUT', `/api/notes/${id}`, {
      body: text,
      type: 'text/plain; charset=utf-8',
      headers: { 'X-Margin-Writer': writerId, 'X-Margin-Seq': String(++saveSeq) },
    });
    const meta = await res.json();
    saving = false;
    updateNote(meta);
    if (id !== currentId) return true;
    if (meta.stale) {
      // A newer save from this tab (the page-close save) got there first, so
      // this text wasn't written. Save the editor's text again.
      setStatus('Unsaved changes');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_DELAY_MS);
      return true;
    }
    savedText = text;
    setStatus(hasUnsaved() ? 'Unsaved changes' : 'Saved');
    return true;
  } catch (err) {
    saving = false;
    if (err.status === 401) {
      setStatus('Not saved: you have been logged out. Copy your text before reloading the page.', true);
    } else if (err.status === 413) {
      setStatus('Not saved: this note is over 1 MB. Remove some text to save it.', true);
    } else {
      setStatus(`Not saved: ${err.message}. Retrying…`, true);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, RETRY_DELAY_MS);
    }
    return false;
  }
}

els.text.addEventListener('input', () => {
  if (currentId === null) return;
  setStatus('Unsaved changes');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && hasUnsaved()) save();
});

// Last-chance save when the page is closed. keepalive lets the request outlive
// the page; its higher number makes the server skip any older save from this
// tab that is still in flight.
window.addEventListener('pagehide', () => {
  if (!hasUnsaved()) return;
  const body = els.text.value;
  if (new Blob([body]).size > KEEPALIVE_MAX_BYTES) return;
  fetch(`/api/notes/${currentId}`, {
    method: 'PUT',
    body,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Margin-Writer': writerId,
      'X-Margin-Seq': String(++saveSeq),
    },
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {});
});

// A note too large for the keepalive save can't be saved reliably while the
// page closes, so ask before leaving with those changes unsaved.
window.addEventListener('beforeunload', (event) => {
  if (hasUnsaved() && new Blob([els.text.value]).size > KEEPALIVE_MAX_BYTES) event.preventDefault();
});

// ---- actions -------------------------------------------------------------

// Runs one switch/create/logout at a time; clicks made meanwhile are ignored.
// The editor is read-only throughout, so no keystrokes land on the wrong note.
// `fn` receives whether the current note was saved.
async function exclusive(fn) {
  if (busy) return;
  busy = true;
  els.text.readOnly = true;
  els.appView.classList.add('busy');
  try {
    await fn(await save());
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    els.text.readOnly = false;
    els.appView.classList.remove('busy');
  }
}

function selectNote(id) {
  if (id === currentId) return;
  return exclusive(async (saved) => {
    if (!saved) return;
    const res = await api('GET', `/api/notes/${id}`);
    openNote(id, await res.text());
    renderList();
    els.text.focus();
  });
}

function createNote() {
  return exclusive(async (saved) => {
    if (!saved) return;
    const res = await api('POST', '/api/notes');
    const meta = await res.json();
    openNote(meta.id, '');
    updateNote(meta);
    els.text.focus();
  });
}

function logout() {
  return exclusive(async (saved) => {
    if (!saved && !confirm('Your latest changes are not saved. Log out anyway?')) return;
    await api('POST', '/api/logout');
    showLogin();
  });
}

async function login(event) {
  event.preventDefault();
  const form = els.loginForm.elements;
  els.loginError.textContent = '';
  try {
    await api('POST', '/api/login', {
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
      type: 'application/json',
    });
    const res = await api('GET', '/api/notes');
    showApp(await res.json());
  } catch (err) {
    els.loginError.textContent = err.message;
    form.password.value = '';
    form.password.focus();
  }
}

els.loginForm.addEventListener('submit', login);
els.newNote.addEventListener('click', createNote);
els.logout.addEventListener('click', logout);

async function boot() {
  try {
    const res = await api('GET', '/api/notes');
    showApp(await res.json());
  } catch (err) {
    showLogin(err.status === 401 ? '' : err.message);
  }
}

boot();
