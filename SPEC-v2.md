# Margin v2 — Spec: collapsible sidebar, titles, dates, tags

Builds on the current app (see ARCHITECTURE.md). Everything not mentioned here
stays as it is. Revised after beta's spec review (7 reviewers).

## Features (from the user; nothing else is in scope)

1. The sidebar can be collapsed.
2. A note's title is the first line of its file.
3. In the sidebar, under each title, in a smaller font: the last update date/time.
4. A menu bar at the top of the note, where tags can be added to the note.
   A tag is lowercase, no spaces, only `a-z` and `0-9`.
5. In the sidebar, under each title, the note's tags.
6. At the top of the sidebar, a dropdown to pick a tag; the list then shows only
   notes with that tag.

## Decisions (user accepted these defaults)

- **Title:** strictly the first line. Blank first line → "Untitled". Cut at 80
  characters.
- **Tag storage:** a sidecar file next to each note, `<id>.json`.
- **Removing tags:** yes, an × on each tag in the menu bar.
- **Limits:** a tag is 1–32 characters; at most 20 tags per note.
- **Tagging is not an update:** adding/removing tags does not change the note's
  last update time or its position in the list. Only text edits do.
- **Dropdown:** "All notes" plus every tag used in the user's notes; one tag at a
  time.
- **New note while a tag is selected:** the new note gets that tag.
- **Date/time format:** the browser's local time, medium date + short time
  (e.g. "Oct 25, 2026, 2:14 PM").
- **Collapse:** a toggle button at the top-left; the sidebar hides completely;
  the state is remembered in the browser (localStorage).
- **Menu bar:** holds only tags (and the sidebar toggle when collapsed).

Consequences, stated so they aren't surprises:

- While the sidebar is collapsed, New note, the filter and Log out are not
  available until it is expanded (they live in the sidebar).
- Notes whose first line is blank are all titled "Untitled"; the date tells
  them apart.
- Across tabs, the last tag save to reach the server wins, and a save replaces
  the whole tag set: a tab showing stale tags can remove a tag another tab
  added. Same rule as text.

## Storage

```
/data/notes/<username>/
  <uuid>.txt     # note text (unchanged); its existence is what makes a note
  <uuid>.json    # {"tags": ["ideas", "work"]}  (optional)
```

### Writing

- Both files of a note are written under **one** per-note lock, keyed by the
  note (its `.txt` path), never by the `.json` path. A text save and a tag save
  to one note never interleave.
- Sidecars use the existing atomic write (temp file, fsync, rename, fsync dir),
  mode 0600.
- Tags in the file are unique and sorted alphabetically. Removing the last tag
  writes `{"tags": []}` (the file isn't deleted).
- The note's "last update" is the mtime of `<uuid>.txt` only; writing
  `<uuid>.json` never touches it.
- A tag save first checks, inside the lock, that `<uuid>.txt` exists and is a
  regular file; otherwise 404 and nothing is written (no orphan sidecars).

### Creating a tagged note

1. Parse and validate the request's tags. Invalid → 400; nothing is created.
2. If there are tags, write `<uuid>.json` first.
3. Create `<uuid>.txt` (this is what makes the note exist and appear).
4. If step 3 fails, remove the sidecar and return 500.

A crash between steps 2 and 3 leaves a sidecar with no note. It is invisible
(notes are listed by `.txt`), and the startup sweep removes `.json` files that
have no matching `.txt`.

### Reading

- Opened with `O_NOFOLLOW`, must be a regular file, at most 4 KB read.
- Valid means exactly: a JSON object whose `tags` is an array of at most 20
  strings, each matching `^[a-z0-9]{1,32}$`. It is de-duplicated and sorted on
  read.
- Missing file → no tags. Anything else (unreadable, symlink, too big, bad
  JSON, wrong shape, any invalid element) → treated as no tags, logged once per
  file per server process. The note still lists and opens; the next tag save
  overwrites the file.
- An error reading the sidecar never fails the note's listing.

## Title

- The first line of the file: text up to the first `\n` (a trailing `\r` is
  dropped), from the first 4 KB. Leading/trailing whitespace is trimmed for
  display. Empty after trimming → "Untitled". Cut at 80 characters, counted as
  Unicode code points (never splitting a character).
- Change from today: today the label is the first *non-empty* line.
- The field is renamed `label` → `title` in the API (the client and server ship
  together; nothing else reads the API).

## Tags

- Valid tag: `^[a-z0-9]{1,32}$`. Max 20 per note, counted after
  de-duplication. Duplicates in a request are not an error.
- The server validates every tag set; invalid → 400 with a message, nothing
  written.
- The menu bar input: surrounding whitespace is trimmed, one leading `#` is
  dropped (tags are *displayed* with `#`), and the rest is lowercased. If what
  remains is empty, Enter does nothing. If it contains anything outside
  `a-z0-9` or is over 32 characters, it is rejected with a message; nothing
  else is stripped.

## API

| Method | Path                 | Request → response                                           |
|--------|----------------------|--------------------------------------------------------------|
| GET    | /api/notes           | → `[{id, title, mtime, tags}]`, newest first                 |
| POST   | /api/notes           | optional JSON `{"tags": [...]}` → 201 `{id, title, mtime, tags}` |
| GET    | /api/notes/:id       | unchanged (`text/plain`)                                     |
| PUT    | /api/notes/:id       | unchanged input → `{id, title, mtime[, stale]}`              |
| PUT    | /api/notes/:id/tags  | **new.** JSON `{"tags": [...]}` replaces the tag set → `{id, tags[, stale]}` |

- **Routing:** `/api/notes/<id>/tags` is matched before the note-id check.
  Only PUT (405 `Allow: PUT` otherwise). `<id>` must be a valid note id;
  anything else under `/api/notes/<id>/…` → 404.
- **Text save response** no longer includes `tags`, and the tag response
  doesn't include `title`/`mtime`, so neither can overwrite the other's data
  on the client (see "Client state" below).
- **`POST /api/notes` body:** no body (`Content-Length` absent or 0, no
  `Transfer-Encoding`) works as today. Otherwise `Content-Type:
  application/json` is required (415), the body is limited to 4 KB while
  streaming (413), invalid JSON → 400. `{}` means no tags; `tags`, if present,
  must be an array of strings (400 otherwise).
- **`PUT /api/notes/:id/tags` body:** `Content-Type: application/json` (415),
  4 KB streaming limit (413), invalid JSON → 400, `tags` **required** and an
  array of strings (a missing key is a 400, never "clear all tags"). Same
  same-origin check and session check as the other note routes.
- **Tag save ordering:** tag saves carry `X-Margin-Writer` (the tab's id) and
  their **own** `X-Margin-Seq` counter, separate from text saves. The server
  keeps a separate last-applied number for tags (key
  `<note>\0tags\0<writer>`), recorded only after the write succeeds. A tag save
  whose number isn't higher than the last applied one from that tab is skipped
  and returns the current tags with `stale: true`.

## Client state

- **List entries** hold `{id, title, mtime, tags}`. Text-save responses update
  only `title` and `mtime`; tag-save responses update only `tags`. A response
  never replaces a whole entry.
- **The menu bar's tags** come only from: opening the note (from its list
  entry), creating it, and tag-save responses for the open note.
- Every tag request captures the note id when it starts. The list entry is
  updated for that id; the menu bar only if that note is still open.
- Tag lookups use `Set`/`Map`, never plain objects keyed by tag.

## UI

### Sidebar (expanded)

```
┌──────────────────────────────┐
│ «  Margin            Log out │   « collapses the sidebar
│ [ All notes            ▾ ]   │   tag filter
│ [        New note        ]   │
│ ──────────────────────────── │
│ Groceries                    │   title (first line)
│ Oct 25, 2026, 2:14 PM        │   smaller, muted
│ #home #weekly                │   tags, smaller
│ ──────────────────────────── │
│ Meeting notes                │
│ Oct 24, 2026, 9:03 AM        │
│                              │   (no tags → no tag row)
└──────────────────────────────┘
```

- **Filter dropdown:** "All notes" first, then every tag in the user's notes,
  alphabetically. Picking a tag shows only notes that have it.
  - The options are rebuilt only when the set of tags changes, keeping the
    current selection, so an autosave never disturbs it.
  - If the selected tag no longer exists on any note, the filter resets to
    "All notes" (the variable and the `<select>` together).
  - The selection resets to "All notes" on login and logout, and isn't
    remembered across reloads.
  - The dropdown is disabled when there are no tags.
- The open note stays open in the editor even if a tag change hides it from
  the filtered list.
- **Empty states:** no notes at all → "No notes yet". A filter that matches
  nothing can't happen (it resets), but if the list is empty for any reason it
  shows "No notes yet".
- The list is still sorted by last update, newest first.
- Dates use `toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })`.
- All note-derived text (titles, tags) is set with `textContent`.

### Sidebar (collapsed)

- The sidebar gets the `hidden` attribute (out of the layout and the tab
  order); the editor takes the full width.
- A » button at the left of the menu bar expands it again. It is always
  enabled, even with no note open.
- Both toggles have `aria-expanded` and an accessible label.
- State is kept in `localStorage` (`margin.sidebarCollapsed` = `"1"`), applied
  before the first render. Reads and writes are wrapped in try/catch; if
  storage is unavailable the sidebar starts expanded and the toggle still works
  for the session.

### Menu bar (top of the editor)

```
┌──────────────────────────────────────────────────────────────┐
│ »  #home ×  #weekly ×   [ add tag… ]                         │
│    tag message (errors), when there is one                   │
├──────────────────────────────────────────────────────────────┤
│ textarea                                                     │
```

- Shows the open note's tags, each with an × to remove it, and an input to
  add one. Enter adds the typed tag. Adding a tag that's already there does
  nothing. Adding a 21st is refused with a message.
- **One tag save at a time.** While a tag save is in flight, or while a
  switch/create/logout is running, the × buttons and the input are read-only
  (the input keeps focus, so the next tag can be typed right away).
- Each add/remove sends `PUT /api/notes/:id/tags` right away, with
  `keepalive: true` (the body is tiny), so a change made just before closing
  the tab still goes through.
- **Tag messages** (invalid input, limit, save errors) appear in their own line
  under the input, never in the text status line. A message clears on the next
  successful tag action or when another note is opened.
- **On failure:**
  - 400 / 404 / 413 / 415 (the server wrote nothing): the menu bar goes back to
    the last saved tags and the message says why.
  - 401: same handling as a text save (logged-out message).
  - Network error, timeout or 5xx (the save may or may not have happened): the
    client reloads `GET /api/notes`, takes that note's tags from it, and shows
    "Couldn't confirm the tag change". Tag edits stay read-only until that
    reload finishes.
  - `stale: true`: adopt the returned tags.
- **Switching / creating / logging out** (`exclusive()`) waits for an in-flight
  tag save as well as the text save, whatever its outcome; a failed tag save
  doesn't block the switch.
- When no note is open, the tag input and × buttons are disabled.

### New note with a filter

- With a tag selected, New note sends `POST /api/notes` with
  `{"tags": ["<selected>"]}`, so the new note appears in the filtered list.

## Docs

ARCHITECTURE.md (files on disk, title rule, API table, frontend) and README.md
(data layout, usage) are updated in the same change.

## Out of scope

Renaming or deleting tags globally, tag colors, multi-tag filters, remembering
the filter, editing the title separately from the text.
