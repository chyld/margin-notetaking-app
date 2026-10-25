# Margin — Architecture

## Features (from the user; nothing else is in scope)

1. Text only (no markdown).
2. List of notes on the left; the note being worked on is on the right.
3. A button to create a new note.
4. Runs with Docker Compose.
5. No database; everything is kept in files.
6. Multiple users; new users are created with a CLI tool.

Decisions from the user:

- Logout button: yes.
- Note list sorted by last modified, newest first.
- Empty notes are fine (no delete).
- Same note open in two tabs: the most recent save wins.
- Full network access on port 5555, plain HTTP.

## Overview

One container, one Node.js process, zero npm dependencies. The server serves a
static page and a JSON API, and reads/writes plain files in `./data`, which is
bind-mounted at `/data`. A CLI script in the same image creates users.

```
browser ──HTTP :5555──> margin container (node:22-alpine, non-root, read-only rootfs)
                          ├─ src/server.js   HTTP server, routing, API
                          ├─ src/auth.js     scrypt hashing, signed session tokens
                          ├─ src/store.js    files: users.json, notes, atomic writes
                          ├─ src/cli.js      create-user
                          ├─ public/         index.html, app.js, style.css
                          └─ /data  <── bind mount ./data
```

## Docker Compose

- Publishes `5555:5555` on all interfaces (plain HTTP, by decision).
- Runs as `${MARGIN_UID:-1000}:${MARGIN_GID:-1000}` so files in `./data` stay
  owned by the host user. `data/.gitkeep` is committed so `./data` exists (and
  is user-owned) on a fresh clone; otherwise Docker would create it as root.
- `init: true`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`.
- `.dockerignore` keeps `data/` and `.env` out of the image.

## Files on disk (`/data`)

```
/data/
  session_secret          # 32 random bytes (hex), generated on first start, 0600
  users.json              # { "<username>": { salt, hash, N, r, p, keylen } }, 0600
  users.lock/             # exists only while the CLI is writing users.json
  notes/<username>/<uuid>.txt   # one UTF-8 plain-text file per note, 0600
```

- The process umask is `077`: directories are `0700`, files `0600`.
- **Note ID** is a random UUID v4. The note body is the whole file.
- **Label** is the first non-empty line (trimmed, max 80 chars) of the first
  4 KB of the file, or "Untitled". The list and save responses use the same code.
- **Order** is file mtime, newest first, ties broken by ID.
- **Atomic writes:** write `.<name>.tmp-<random>` (`O_EXCL`, `0600`) in the same
  directory, `fsync`, `rename` over the target, `fsync` the directory. Leftover
  temp files are removed at startup and never match the note filename pattern.
- Notes are opened with `O_NOFOLLOW` and must be regular files.

## Users and sessions

- **users.json** is written only by the CLI and read fresh by the server on every
  login and every authenticated request, so new users work without a restart.
  It is parsed into a `Map` (so `__proto__` etc. are ordinary keys).
- **Passwords:** scrypt `N=16384, r=8, p=1, keylen=64`, 16-byte salt, params
  stored per user. Async scrypt; constant-time compare; an unknown username is
  checked against a dummy hash so timing doesn't reveal which users exist.
- **Login throttling:** each attempt counts as soon as it starts. Limits per
  15 minutes: 5 per IP + username, 20 per IP → `429`. A successful login refunds
  only its own attempt. At most 8 password checks run at once (`503` beyond).
- **Session token:** `<username>.<expiry>.<HMAC-SHA256(secret, "<username>.<expiry>")>`
  (base64url). Verified with a strict format check, username regex, expiry in
  the future (no upper bound; the MAC covers it), and constant-time MAC compare;
  then the user must still exist.
- **Cookie:** `margin_session`, `HttpOnly; SameSite=Strict; Path=/; Max-Age=7d`.
  No `Secure` flag (plain HTTP). Logout clears the cookie; a copied token stays
  valid until it expires. An invalid session cookie is cleared; a failed login
  doesn't touch the cookie.
- **Secret:** generated on first start into `/data/session_secret`; deleting the
  file and restarting logs everyone out.

## CLI

```
docker compose exec margin node src/cli.js create-user <username>
```

- Username `^[a-z0-9_-]{1,32}$`; refuses existing users.
- Requires a TTY; prompts twice without echo; minimum 8 characters. Input is
  buffered across prompts; escape sequences and control characters are ignored.
- Creates `notes/<username>/` first, then updates `users.json` under an
  exclusive lock (`mkdir users.lock`) with an atomic write. The lock is never
  taken over automatically; if it is left behind, the CLI says to remove it.

## HTTP

Static: exactly `/`, `/app.js`, `/style.css`, served from memory. No URL is
mapped onto the filesystem.

| Method | Path            | Notes                                                          |
|--------|-----------------|----------------------------------------------------------------|
| POST   | /api/login      | JSON `{username, password}`, body ≤ 4 KB → `{username}` + cookie |
| POST   | /api/logout     | clears cookie → 204                                            |
| GET    | /api/notes      | `[{id, label, mtime}]`, newest first                           |
| POST   | /api/notes      | creates an empty note → 201 `{id, label, mtime}`               |
| GET    | /api/notes/:id  | `text/plain; charset=utf-8`                                    |
| PUT    | /api/notes/:id  | `text/plain` body ≤ 1 MB → `{id, label, mtime[, stale]}`; 404 if absent |

- `:id` must fully match the UUID v4 pattern, otherwise 404. 405s include `Allow`.
- **Save order:** writes to one note run one at a time in arrival order. A PUT
  may carry `X-Margin-Writer` (random id per tab) and `X-Margin-Seq` (increasing
  per tab); a PUT whose number is not higher than the last one applied from the
  same tab for that note is skipped (`stale: true`). Tabs aren't compared with
  each other, so across tabs the most recent save wins.
- Body limits are enforced while streaming (413, connection closed).
- State-changing requests are refused (403) if `Sec-Fetch-Site` is cross-site
  or `Origin` doesn't match `Host`. Login requires `application/json`.
- Every response: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, and a `default-src 'self'` CSP. API responses: `no-store`.
- A 401 also clears the session cookie.

## Frontend

- On load, `GET /api/notes`: 401 shows the login form, 200 shows the app.
- **Left:** "Margin", "Log out", "New note", then the note list (labels are set
  with `textContent`, never HTML).
- **Right:** a `<textarea>`; disabled until a note is selected or created.
  A status line shows Unsaved changes / Saving… / Saved / Not saved.
- **Autosave:** 500 ms after typing stops, when switching notes, creating a
  note, logging out, or hiding the tab. Saves are chained so only one is in
  flight. "Unsaved" means the editor differs from the text the server last
  confirmed, so a save still in flight counts as unsaved.
- **Closing the page:** a `keepalive` PUT with the next sequence number (so an
  older in-flight save can't overwrite it). Browsers cap keepalive bodies at
  64 KiB, so for larger unsaved notes the browser asks before leaving.
- **Switch / new note / logout** run one at a time (extra clicks are ignored)
  with the editor read-only throughout. They save first; if that fails, switching
  and creating stop, and logout asks for confirmation.
- **Failed saves** show the error and retry every 3 s, except 401 (logged out)
  and 413 (over 1 MB), which say what to do.
- After each save the list label and order update.
