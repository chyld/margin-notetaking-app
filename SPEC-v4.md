# Margin v4 — Spec: links to a note or a tag

Builds on v3 (see SPEC-v3.md, SPEC-v2.md, ARCHITECTURE.md). Everything not
mentioned here stays as it is.

## Features (from the user; nothing else is in scope)

1. A particular note can be bookmarked (its link opens that note).
2. A particular tag can be bookmarked (its link opens the list filtered to
   that tag).

## Decisions

From the user:

- The link uses `?` (a query string).
- Opening a link while logged out shows the login form first.
- Not found → 404.
- Back and Forward are ignored (opening notes doesn't add history entries).

Defaults (not raised by the user):

- **Parameters:** `?note=<note id>` and `?tag=<tag>`. A note's id is its
  existing UUID; a tag's id is its name (already unique per user, and the only
  identity a tag has). Example: `http://host:5555/?note=3f2b…e1`,
  `http://host:5555/?tag=work`.
- **The address always reflects what's on screen,** so whatever is open can
  be bookmarked from the address bar: `note` is set while a note is open,
  `tag` while a tag filter is selected. Both can be present
  (`?tag=work&note=…`), and such a link restores both.
- Not found shows a short message in the app (no separate error page).
- Logging out resets the address to `/`.

## Address updates

- Uses `history.replaceState`, never `pushState`, so no history entries are
  added and Back/Forward leave the app as before.
- Updated when: a note is opened or created (`note`), the filter changes
  (`tag`, removed for "All notes"), the filter resets because its tag
  disappeared, and logout (both removed).
- Parameters are written with `URLSearchParams`. Other query parameters and
  the path are not used; on any update the address becomes exactly `/` plus
  Margin's own parameters.

## Opening a link

On load (after login if needed), the client reads `note` and `tag` once:

1. `tag`: if it is a valid tag (`^[a-z0-9]{1,32}$`) that at least one of the
   user's notes has, the filter is set to it. Otherwise: not found.
2. `note`: if it is a valid note id and the user has that note, it is opened
   (through the normal open path, so the editor, menu bar and Save state are
   set up as when clicking it). Otherwise: not found.
3. The address is then rewritten to what is actually on screen (a parameter
   that wasn't found is dropped).

- **Logged out:** the login form is shown and the address is kept; after a
  successful login the steps above run.
- **Another user's note** is not found: notes are only ever looked up in the
  logged-in user's own folder, so the response is the same as for a note that
  doesn't exist.

## Not found (404)

- **HTTP status:** a `GET /` (or `HEAD /`) whose `note` or `tag` parameter
  can't be resolved for the logged-in user is answered with status **404**
  and the normal app page (same body and headers as `/`). This applies when
  the request has a valid session; without one the server can't tell, so it
  answers 200 and the client handles it after login.
  - `note` not found: not a valid UUID v4, or no such regular file in the
    user's notes folder.
  - `tag` not found: not a valid tag, or no note of the user has it.
  - A parameter that is present but empty counts as not found; an absent one
    is ignored.
- **In the app:** the status line shows "Note not found." or
  "No notes with tag #<tag>." (set with `textContent`; the tag is shown only
  if it is valid, otherwise "Tag not found."). The rest of the app opens
  normally (all notes, nothing selected unless the other parameter was found).
- The server's 404 check uses the same session and lookup code as the API and
  reveals nothing more than the API already does to the same user.

## Server changes

- The `/` handler parses the query string. If `note` or `tag` is present and
  the request has a valid session for an existing user, it resolves them
  (a note: the same check `readNote` uses; a tag: scan the user's notes' tags)
  and picks 200 or 404. The body is always the in-memory `index.html`.
- No other routes change. The page stays `Cache-Control: no-cache`.

## Docs

README (Using Margin: links/bookmarks) and ARCHITECTURE.md (HTTP: `/` with
`note`/`tag`; Frontend: address updates) are updated in the same change.

## Out of scope

Back/Forward navigation between notes, share/copy-link buttons, links to
other views, pretty paths (`/notes/<id>`), links across users.
