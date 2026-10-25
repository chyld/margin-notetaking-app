# Margin v4 — Spec: links to a note or a tag

Builds on v3 (see SPEC-v3.md, SPEC-v2.md, ARCHITECTURE.md). Everything not
mentioned here stays as it is. Revised after beta's spec review (7 reviewers).

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
  identity a tag has). Examples: `http://host:5555/?note=3f2b…e1`,
  `http://host:5555/?tag=work`, `http://host:5555/?note=3f2b…e1&tag=work`.
- While the app is shown, the address is kept in step with what's open (a note
  and/or the selected tag), so it can be bookmarked from the address bar.
- Not found shows a short message in the app (no separate error page).
- Logging out (the Log out button) resets the address to `/`.

Consequences, stated so they aren't surprises:

- **Links opened from another site or app** (email, chat) arrive without the
  login cookie, because it is `SameSite=Strict`, so Margin shows the login form
  even if you're logged in. Bookmarks and typed addresses work normally.
  (Pending the user's decision; see the end.)
- **Editing the address by hand** loads the page again; the v3 "Leave site?"
  prompt applies if there are unsaved changes.
- Back/Forward still move between real page loads (e.g. a bookmark opened in
  the same tab); in-app changes never add entries.

## Parsing a link (client and server alike)

- Parsed with `URLSearchParams`. For a repeated parameter, the first value
  wins (`get`).
- A parameter is *absent* if `has()` is false (ignored). Present but empty
  (`?note=` or `?note`) counts as not found.
- `note` is found only if it matches the server's UUID v4 pattern **and** the
  user has that note. `tag` is found only if it matches `^[a-z0-9]{1,32}$`
  **and** at least one of the user's notes has it.
- Only the logged-in user's own notes are ever searched (the username comes
  from the session only), so another user's note is simply not found.

## Server: `GET /` and `HEAD /`

- If neither `note` nor `tag` is present: exactly as today (no session check,
  no file access).
- Otherwise the static handler, after its existing method check, decides 200
  or 404 and then sends the normal page:
  1. **Session, without failing:** verify the cookie's token and that the user
     exists. Missing, invalid or expired token, a deleted user, or any error
     reading `users.json` → "no session" → **200**. The `/` route never sends
     `Set-Cookie` (the app's first API call clears a bad cookie, as today).
  2. **Resolve** with store functions (never by building paths from the
     parameter): `note` is checked with `store.isNoteId` and a new
     `store.noteExists(username, id)` (the `notePath` + `openNote` check:
     no symlinks, regular file, **no body read**). If `tag` is present, one
     `store.listNotes(username)` call answers both (it already ignores orphan
     sidecars and unusable tag files, so it matches what the client sees).
  3. Any parameter not found → **404**, else 200. Any error while resolving →
     logged once, **200** (the check can never make the page unavailable).
- Same headers for 200 and 404 (security headers, `Content-Type`,
  `Content-Length`); `GET` sends the in-memory `index.html`, `HEAD` no body.
- `/` gets `Cache-Control: private, no-cache` (the status is now per-user).
- No redirects are ever sent from `/`.
- The 404 only sets the document's status (for link checkers, devtools). The
  page can't read it; the in-app message comes from the client's own check
  below, which uses the same rules.

## Client: opening a link

- At startup, before anything else, `note` and `tag` are read from
  `location.search` into a pending link. It is used **once per page load**:
  the first time the notes view is shown (right after boot, or after the
  first successful login if the session had expired). A later re-login in
  the same page doesn't reuse it.
- While logged out the address isn't touched, so the link survives the login.
- Steps, after `showApp()` has rendered the notes list:
  1. **Tag:** if found, set the filter exactly as picking it in the dropdown
     does (the variable, the `<select>` and the list are updated together).
  2. **Note:** look it up in the full notes list (independent of the filter).
     If it's there, load it with `GET /api/notes/:id` and open it with
     `openNote()` (no unsaved-changes prompt is needed: nothing is open yet).
     - 404 from the API → not found.
     - Any other failure (network, timeout, 5xx, 401): the note isn't opened,
       the address keeps `note` (it may work on reload), and the status line
       shows the error. A 401 follows the v3 rules (login form).
  3. **Message:** set last, after the note is open, as an error in the status
     line, so nothing clears it. Precedence: if the note wasn't found,
     "Note not found."; otherwise if the tag wasn't found, "No notes with tag
     #<tag>." (only if the tag is valid) or "Tag not found.". Set with
     `textContent`. It stays until the next status change (typing, a save).
  4. **Address:** rewritten to what is actually open (a parameter that wasn't
     found is dropped; one kept after a temporary failure stays until the user
     opens or creates a note or changes the filter).

## Client: keeping the address in step

- One function, `syncAddress()`, builds the address from state:
  `/` + `?note=<currentId>` (if a note is open) + `&tag=<filterTag>` (if a
  filter is selected), in that order, with `URLSearchParams`. Any other query
  parameters and any `#fragment` are dropped.
- It calls `history.replaceState` only if the result differs from the current
  address, inside try/catch (Safari throttles history calls).
- It is called after the state has settled: at the end of `openNote()` (note
  opened or created), when the filter changes or resets (the reset inside
  `renderFilter` is reported, and the address synced after rendering), and at
  the end of link resolution. It does nothing while the login form is shown
  or before the pending link has been resolved.
- It is never called when an action is cancelled (the v3 discard confirm) or
  fails: the address changes only after a note has actually opened.
- **Log out:** after the logout request succeeds, the address becomes `/`. A
  failed logout leaves it unchanged. A 401 that shows the login form doesn't
  touch the address; when the notes view is shown again, it's synced to what's
  open (nothing).
- No `popstate` handler is added. `replaceState` never triggers the
  `beforeunload` prompt.

## Docs

README (Using Margin: links and bookmarks, the cross-site login note) and
ARCHITECTURE.md (HTTP: `/` with `note`/`tag`, status and caching; Frontend:
the address) are updated in the same change.

## Out of scope

Back/Forward navigation between notes, share/copy-link buttons, links to
other views, pretty paths (`/notes/<id>`), links across users, redirects.

## Open question for the user

Links opened from another site or app show the login form even when you're
logged in, because the login cookie is `SameSite=Strict`. Changing it to
`SameSite=Lax` would let such links open directly, with slightly less
protection against cross-site requests (Margin also checks the `Origin` of
every change, so the practical risk stays low). Default: keep `Strict`.
