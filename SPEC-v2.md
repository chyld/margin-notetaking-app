# Margin v2 — Spec: collapsible sidebar, titles, dates, tags

Builds on the current app (see ARCHITECTURE.md). Everything not mentioned here
stays as it is.

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

## Storage

```
/data/notes/<username>/
  <uuid>.txt     # note text (unchanged)
  <uuid>.json    # {"tags": ["ideas", "work"]}  (optional)
```

- A missing `<uuid>.json` means no tags. Existing notes keep working.
- Tags in the file are unique and sorted alphabetically.
- Written with the existing atomic write (temp file, fsync, rename, fsync dir),
  mode 0600, under the same per-note lock as text writes so a text save and a
  tag save to one note never interleave.
- The note's "last update" is the mtime of `<uuid>.txt` only; writing
  `<uuid>.json` does not touch it.
- An unreadable or malformed `<uuid>.json` is logged and treated as no tags
  (the note still lists and opens). It is overwritten on the next tag change.
- Temp files from either kind of write are cleaned at startup (existing sweep).
- The list never shows a `.json` file as a note (existing filename pattern).

## Title

- The first line of the file: text up to the first `\n` (a trailing `\r` is
  dropped), read from the first 4 KB. Leading/trailing whitespace is trimmed for
  display. Empty after trimming → "Untitled". Cut at 80 characters.
- Change from today: today the label is the first *non-empty* line. A note that
  starts with a blank line will now be titled "Untitled".
- The field is renamed `label` → `title` in the API.

## Tags

- Valid tag: `^[a-z0-9]{1,32}$`. Max 20 per note.
- The server validates every tag set; invalid input → 400 with a message, and
  nothing is written.
- The menu bar input lowercases what's typed. Anything else outside `a-z0-9`
  (spaces, punctuation, accents) is rejected with a message under the input;
  nothing is silently stripped.
- Across tabs, the most recent tag save wins (same rule as text).

## API changes

| Method | Path                 | Change                                                       |
|--------|----------------------|--------------------------------------------------------------|
| GET    | /api/notes           | items become `{id, title, mtime, tags}`                      |
| POST   | /api/notes           | optional JSON body `{"tags": [...]}` (used when a filter is active) → 201 `{id, title, mtime, tags}` |
| PUT    | /api/notes/:id       | unchanged input; response `{id, title, mtime, tags[, stale]}` |
| PUT    | /api/notes/:id/tags  | **new.** JSON `{"tags": [...]}` replaces the note's whole tag set → `{id, title, mtime, tags}`; 404 if the note doesn't exist; body ≤ 4 KB |

- `POST /api/notes` with a body requires `Content-Type: application/json`;
  without a body it works as today.
- `PUT /api/notes/:id/tags` goes through the same same-origin check, session
  check and note-id validation as the other note routes. The server sorts and
  de-duplicates; duplicates are not an error.
- Tags are returned with every note so the client can build the dropdown and
  filter without extra requests. No separate tags endpoint.

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
  alphabetically. Picking a tag shows only notes that have it. The selection is
  not remembered across reloads. If the selected tag no longer exists on any
  note (its last use was removed), the dropdown resets to "All notes".
- The open note stays open in the editor even if a tag change hides it from
  the filtered list.
- The list is still sorted by last update, newest first.
- Dates use `toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })`.
- All note-derived text (titles, tags) is set with `textContent`.

### Sidebar (collapsed)

- The sidebar is hidden completely; the editor takes the full width.
- A » button at the left of the menu bar expands it again.
- State is kept in `localStorage` (`margin.sidebarCollapsed` = `"1"`), applied
  on load before the first render so it doesn't flash.

### Menu bar (top of the editor)

```
┌──────────────────────────────────────────────────────────────┐
│ »  #home ×  #weekly ×   [ add tag… ]                         │
├──────────────────────────────────────────────────────────────┤
│ textarea                                                     │
```

- Shows the open note's tags, each with an × to remove it, and an input to
  add one. Enter adds the typed tag.
- Adding a tag that's already there does nothing. Adding a 21st tag is refused
  with a message.
- Each add/remove sends `PUT /api/notes/:id/tags` right away (no debounce).
  While it is in flight the tag controls are disabled, so tag saves for a note
  never overlap. On failure the menu bar goes back to the last saved tags and
  the error shows in the status line.
- When no note is open, the tag controls are disabled.
- Tag saves are separate from text autosave: they don't wait for it and don't
  affect "Unsaved changes". Switching notes waits for an in-flight tag save, as
  it does for text.
- After a tag save, the list entry and dropdown update from the response.

### New note with a filter

- With a tag selected, New note sends `POST /api/notes` with
  `{"tags": ["<selected>"]}`, so the new note appears in the filtered list.

## Out of scope

Renaming or deleting tags globally, tag colors, multi-tag filters, remembering
the filter, editing the title separately from the text.
