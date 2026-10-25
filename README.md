# Margin

A plain-text notetaking app. Notes are kept as text files; there is no database.

## Run

Requires Docker with Compose.

```sh
docker compose up -d --build
```

Margin is then available on port 5555 of this machine, e.g. `http://localhost:5555`.

The container runs as UID/GID 1000 by default so files in `./data` stay owned by
you. If your user has a different ID (check with `id -u`), write it to `.env`
before starting, so every `docker compose` command (including the CLI below)
uses it:

```sh
printf 'MARGIN_UID=%s\nMARGIN_GID=%s\n' "$(id -u)" "$(id -g)" > .env
```

## Create a user

```sh
docker compose exec margin node src/cli.js create-user <username>
```

You'll be asked for a password twice. Usernames use lowercase letters, digits,
`_` and `-` (up to 32 characters); passwords need at least 8 characters.

## Data

Everything lives in `./data`:

- `users.json` — usernames and password hashes
- `notes/<username>/<id>.txt` — one file per note
- `session_secret` — signs login cookies; delete it and restart to log everyone out

Back up by copying `./data`.

Margin is served over plain HTTP, so use it on a network you trust.
