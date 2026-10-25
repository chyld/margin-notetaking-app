# Margin — Features requested

Everything here was asked for or decided by the user. Defaults the user
accepted are marked *(accepted default)*. Implementation details that came
from reviews are in the SPEC files, not here.

## Core (v1) — built

- The app is called **Margin**.
- Notes are plain text only (no markdown).
- The list of notes is on the left; the note being worked on is on the right.
- A button to create a new note.
- Runs with Docker Compose.
- No database; everything is kept in files.
- Multiple users; new users are created with a CLI tool.
- A logout button.
- The note list is sorted by last modified, newest first.
- Empty notes are fine (no delete).
- The same note open in two tabs: the most recent save wins.
- Full network access, on port 5555.
- Plain HTTP (no HTTPS).

## README and favicon — built

- README with instructions to install and set up the app.
- A favicon.

## v2 — built

- The sidebar can be collapsed.
- A note's title is the first line of its file.
- In the sidebar, under each title, the last update date/time in a smaller
  font.
- A menu bar at the top of the note where tags can be added to the note.
- A tag is lowercase, no spaces, only `a-z` and `0-9`.
- In the sidebar, under each title, the note's tags.
- At the top of the sidebar, a dropdown to pick a tag; the list then shows
  only notes with that tag.

Accepted defaults:

- Title is strictly the first line; "Untitled" if it's blank; cut at 80
  characters. *(accepted default)*
- Tags are stored in a file next to each note. *(accepted default)*
- Tags can be removed (× on each tag). *(accepted default)*
- A tag is 1–32 characters; at most 20 tags per note. *(accepted default)*
- Changing tags doesn't count as an update (doesn't change the date or the
  order). *(accepted default)*
- The dropdown lists "All notes" plus every tag; one tag at a time.
  *(accepted default)*
- A new note created while a tag is selected gets that tag.
  *(accepted default)*
- Date/time in local time, e.g. "Oct 25, 2026, 2:14 PM". *(accepted default)*
- The collapse toggle is at the top-left, hides the sidebar completely, and
  is remembered by the browser. *(accepted default)*
- The menu bar holds only tags (and the sidebar toggle when collapsed).
  *(accepted default)*

## v3 — built

- No autosave: a note is saved only on demand.
- A Save button in the menu bar.
- The Save button is colored according to its state.
- Ctrl+S saves (⌘S on macOS).
- The browser always prompts before changes would be lost (switching notes,
  New note, Log out, closing or reloading the tab).
- Tags keep saving automatically when changed.
- Mobile browsers may close a tab without the prompt; accepted and
  documented. *(accepted default)*

## v4 — spec written, not built yet

- A particular note can be bookmarked.
- A particular tag can be bookmarked.
- The link uses `?` (a query string).
- Opening a link while logged out shows the login form first.
- Not found → 404.
- Back and Forward buttons are ignored.
- Open question: keep the login cookie `SameSite=Strict` (links opened from
  other sites show the login form) or switch to `Lax`.
