'use strict';

const SAVE_DELAY_MS = 500;
const RETRY_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
// Browsers refuse keepalive requests whose bodies total more than 64 KiB.
const KEEPALIVE_MAX_BYTES = 60 * 1024;
const TAG_RE = /^[a-z0-9]{1,32}$/;
const MAX_TAGS = 20;
const SIDEBAR_KEY = 'margin.sidebarCollapsed';
const DATE_FORMAT = { dateStyle: 'medium', timeStyle: 'short' };

const els = {
  loginView: document.getElementById('login-view'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  appView: document.getElementById('app-view'),
  sidebar: document.getElementById('sidebar'),
  collapse: document.getElementById('collapse'),
  expand: document.getElementById('expand'),
  logout: document.getElementById('logout'),
  filter: document.getElementById('tag-filter'),
  newNote: document.getElementById('new-note'),
  list: document.getElementById('note-list'),
  listEmpty: document.getElementById('list-empty'),
  noteTags: document.getElementById('note-tags'),
  tagInput: document.getElementById('tag-input'),
  tagMessage: document.getElementById('tag-message'),
  text: document.getElementById('note-text'),
  status: document.getElementById('status'),
};

let notes = []; // [{ id, title, mtime, tags }], newest first
let currentId = null;
let savedText = ''; // the current note's text as last confirmed by the server
let saving = false; // a save is in flight; its text isn't confirmed yet
let saveTimer = null;
let saveChain = Promise.resolve(true);
let busy = false; // a switch, create, or logout is in progress
let filterTag = ''; // '' means all notes
let filterOptionsKey = null; // the tag set the dropdown was last built from

// Tag saves run one at a time. While one is in flight the menu bar shows the
// tags being saved; afterwards it shows the note's saved tags again.
let tagSave = null; // { id, tags } while a tag save is in flight
let tagChain = Promise.resolve();
let tagsReloading = false; // re-reading tags after a tag save of unknown outcome

// Every save carries this tab's id and an increasing number, so the server can
// skip an older save from this tab that arrives after a newer one. Text and
// tag saves are numbered separately.
const writerId = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
let saveSeq = 0;
let tagSeq = 0;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Requests time out so a stalled connection can't leave the app stuck.
async function api(method, url, { body, type, headers = {}, keepalive = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: { ...(type ? { 'Content-Type': type } : {}), ...headers },
      credentials: 'same-origin',
      keepalive,
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

function setTagMessage(message) {
  els.tagMessage.textContent = message;
}

function showError(err) {
  if (err.status === 401) return showLogin();
  setStatus(err.message || 'Something went wrong.', true);
}

function byNewest(a, b) {
  return b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function findNote(id) {
  return notes.find((n) => n.id === id);
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
  setTagMessage('');
  els.tagInput.value = ''; // a half-typed tag belongs to the previous note
  renderTags();
}

// ---- sidebar collapse ----------------------------------------------------

function setCollapsed(collapsed, { persist = true } = {}) {
  els.sidebar.hidden = collapsed;
  els.expand.hidden = !collapsed;
  els.collapse.setAttribute('aria-expanded', String(!collapsed));
  els.expand.setAttribute('aria-expanded', String(!collapsed));
  if (!persist) return;
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, '1');
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    // Storage unavailable: the state just isn't remembered.
  }
}

function storedCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

els.collapse.addEventListener('click', () => {
  setCollapsed(true);
  els.expand.focus();
});
els.expand.addEventListener('click', () => {
  setCollapsed(false);
  els.collapse.focus();
});

// ---- views ---------------------------------------------------------------

function resetState() {
  clearTimeout(saveTimer);
  notes = [];
  currentId = null;
  savedText = '';
  saving = false;
  tagSave = null;
  tagsReloading = false;
  filterTag = '';
  filterOptionsKey = null;
  els.filter.replaceChildren(els.filter.options[0]);
  els.filter.value = '';
  els.tagInput.value = '';
  els.text.value = '';
  els.text.disabled = true;
  setStatus('');
  setTagMessage('');
}

function showLogin(message = '') {
  resetState();
  els.appView.hidden = true;
  els.loginView.hidden = false;
  els.loginForm.reset();
  els.loginError.textContent = message;
  els.loginForm.elements.username.focus();
}

function showApp(list) {
  resetState();
  notes = list.sort(byNewest);
  els.loginView.hidden = true;
  els.appView.hidden = false;
  renderList();
  renderTags();
}

// Rebuilds the filter options only when the set of tags changes, so an
// autosave never disturbs the dropdown. A selected tag that no longer exists
// resets the filter to all notes.
function renderFilter() {
  const all = new Set();
  for (const note of notes) for (const tag of note.tags) all.add(tag);
  const tags = [...all].sort();
  if (filterTag && !all.has(filterTag)) filterTag = '';
  const key = tags.join(' ');
  if (key !== filterOptionsKey) {
    filterOptionsKey = key;
    const options = tags.map((tag) => {
      const option = document.createElement('option');
      option.value = tag;
      option.textContent = `#${tag}`;
      return option;
    });
    els.filter.replaceChildren(els.filter.options[0], ...options);
  }
  els.filter.value = filterTag;
  els.filter.disabled = tags.length === 0;
}

function renderList() {
  renderFilter();
  const shown = filterTag ? notes.filter((n) => n.tags.includes(filterTag)) : notes;
  const items = shown.map((note) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    // Note text and tags are never treated as HTML.
    const title = document.createElement('span');
    title.className = 'note-title';
    title.textContent = note.title;
    const date = document.createElement('span');
    date.className = 'note-date';
    date.textContent = new Date(note.mtime).toLocaleString(undefined, DATE_FORMAT);
    button.append(title, date);
    if (note.tags.length > 0) {
      const tags = document.createElement('span');
      tags.className = 'note-tags';
      tags.textContent = note.tags.map((t) => `#${t}`).join(' ');
      button.append(tags);
    }
    button.title = note.title;
    if (note.id === currentId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => selectNote(note.id));
    li.append(button);
    return li;
  });
  els.list.replaceChildren(...items);
  els.listEmpty.hidden = shown.length > 0;
}

// Updates only the given fields of a note's list entry: text saves set
// title/mtime, tag saves set tags, so neither can undo the other's result.
function updateNote(id, fields) {
  const note = findNote(id);
  if (!note) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) note[key] = value;
  }
  notes.sort(byNewest);
  renderList();
}

function tagsLocked() {
  return busy || tagSave !== null || tagsReloading;
}

// The menu bar shows the tags being saved while a tag save is in flight,
// otherwise the open note's saved tags.
function renderTags() {
  const note = currentId === null ? null : findNote(currentId);
  const tags = tagSave && tagSave.id === currentId ? tagSave.tags : note ? note.tags : [];
  const locked = tagsLocked();
  const items = tags.map((tag) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `#${tag}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-tag';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove tag ${tag}`);
    remove.disabled = locked;
    remove.addEventListener('click', () => removeTag(tag));
    li.append(label, remove);
    return li;
  });
  els.noteTags.replaceChildren(...items);
  els.tagInput.disabled = currentId === null;
  // Read-only rather than disabled, so the input keeps focus between tags.
  els.tagInput.readOnly = locked;
}

// ---- saving text ---------------------------------------------------------

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
    updateNote(id, { title: meta.title, mtime: meta.mtime });
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

// ---- saving tags ---------------------------------------------------------

// Replaces the note's tags. keepalive (the body is tiny) lets a change made
// just before the tab closes still reach the server.
function saveTags(id, tags) {
  tagSave = { id, tags };
  renderTags();
  tagChain = (async () => {
    try {
      const res = await api('PUT', `/api/notes/${id}/tags`, {
        body: JSON.stringify({ tags }),
        type: 'application/json',
        headers: { 'X-Margin-Writer': writerId, 'X-Margin-Seq': String(++tagSeq) },
        keepalive: true,
      });
      const meta = await res.json();
      updateNote(id, { tags: meta.tags }); // also covers stale: the server's current tags
      if (id === currentId) setTagMessage('');
    } catch (err) {
      const here = id === currentId;
      if (err.status === 401) {
        if (here) setTagMessage('Tag not saved: you have been logged out.');
      } else if ([400, 404, 413, 415].includes(err.status)) {
        // The server wrote nothing, so the saved tags are still right.
        if (here) setTagMessage(`Tag not saved: ${err.message}`);
      } else {
        // The change may or may not have been saved: ask the server.
        await reloadTags(id);
      }
    } finally {
      tagSave = null;
      renderTags();
    }
  })();
  return tagChain;
}

async function reloadTags(id) {
  tagsReloading = true;
  renderTags();
  try {
    const list = await (await api('GET', '/api/notes')).json();
    const fresh = list.find((n) => n.id === id);
    if (fresh) updateNote(id, { tags: fresh.tags });
    if (id === currentId) setTagMessage("Couldn't confirm the tag change. Showing the saved tags.");
  } catch {
    if (id === currentId) setTagMessage("Couldn't confirm the tag change. Reload the page to see the saved tags.");
  } finally {
    tagsReloading = false;
  }
}

function addTag() {
  if (currentId === null || tagsLocked()) return;
  let tag = els.tagInput.value.trim();
  if (tag.startsWith('#')) tag = tag.slice(1);
  tag = tag.toLowerCase();
  if (tag === '') return;
  if (!TAG_RE.test(tag)) {
    setTagMessage(
      [...tag].length > 32
        ? 'A tag can be at most 32 characters.'
        : 'Tags can only contain letters a-z and digits 0-9 (no spaces).',
    );
    return;
  }
  const tags = findNote(currentId).tags;
  if (tags.includes(tag)) {
    // Already there: nothing to do (and nothing to clear).
    els.tagInput.value = '';
    return;
  }
  if (tags.length >= MAX_TAGS) {
    setTagMessage(`A note can have at most ${MAX_TAGS} tags.`);
    return;
  }
  els.tagInput.value = '';
  setTagMessage('');
  saveTags(currentId, [...tags, tag].sort());
}

function removeTag(tag) {
  if (currentId === null || tagsLocked()) return;
  setTagMessage('');
  saveTags(
    currentId,
    findNote(currentId).tags.filter((t) => t !== tag),
  );
}

els.tagInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addTag();
});

// ---- actions -------------------------------------------------------------

// Runs one switch/create/logout at a time; clicks made meanwhile are ignored.
// The editor and tag controls are locked throughout, so nothing lands on the
// wrong note. It waits for the text save and any tag save; `fn` receives
// whether the text was saved.
async function exclusive(fn) {
  if (busy) return;
  busy = true;
  els.text.readOnly = true;
  els.appView.classList.add('busy');
  renderTags();
  try {
    const saved = await save();
    await tagChain;
    await fn(saved);
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    els.text.readOnly = false;
    els.appView.classList.remove('busy');
    renderTags();
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

// With a tag selected in the filter, the new note gets that tag: the one
// selected when New note was clicked, even if the filter changes meanwhile.
function createNote() {
  const tag = filterTag;
  return exclusive(async (saved) => {
    if (!saved) return;
    const res = tag
      ? await api('POST', '/api/notes', { body: JSON.stringify({ tags: [tag] }), type: 'application/json' })
      : await api('POST', '/api/notes');
    const meta = await res.json();
    notes.push({ id: meta.id, title: meta.title, mtime: meta.mtime, tags: meta.tags });
    notes.sort(byNewest);
    openNote(meta.id, '');
    renderList();
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
els.filter.addEventListener('change', () => {
  filterTag = els.filter.value;
  renderList();
});

async function boot() {
  setCollapsed(storedCollapsed(), { persist: false });
  try {
    const res = await api('GET', '/api/notes');
    showApp(await res.json());
  } catch (err) {
    showLogin(err.status === 401 ? '' : err.message);
  }
}

boot();
