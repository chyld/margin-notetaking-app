# Margin

A plain-text notetaking app. Notes are kept as text files; there is no database.

## Requirements

- Linux (or any machine with Docker)
- [Docker](https://docs.docker.com/engine/install/) with the Compose plugin
  (`docker compose version` should print a version)
- Git

## Install

```sh
git clone https://github.com/chyld/margin-notetaking-app.git
cd margin-notetaking-app
```

Run the remaining commands from this directory.

## Set up

### 1. Match your user ID

Margin runs as UID/GID 1000 by default, so the files it writes in `./data` stay
owned by you. Check your IDs:

```sh
id -u
id -g
```

If either is not `1000`, write them to `.env` (every `docker compose` command
reads this file, including the CLI below):

```sh
printf 'MARGIN_UID=%s\nMARGIN_GID=%s\n' "$(id -u)" "$(id -g)" > .env
```

### 2. Start Margin

```sh
docker compose up -d --build
```

Check that it's running:

```sh
docker compose ps
docker compose logs margin
```

The log should say `Margin listening on port 5555`.

### 3. Create a user

```sh
docker compose exec margin node src/cli.js create-user <username>
```

You'll be asked for a password twice (nothing is shown as you type).

- Usernames: 1–32 characters, lowercase letters, digits, `_` and `-`.
- Passwords: at least 8 characters.

Repeat for each person who will use Margin. New users can log in right away;
no restart is needed.

### 4. Open Margin

- On the same machine: <http://localhost:5555>
- From another device on your network: `http://<this-machine's-IP>:5555`
  (find the IP with `ip -4 addr` or `hostname -I`). If it doesn't load, allow
  TCP port 5555 in the machine's firewall.

Log in with the username and password you created.

## Using Margin

- **New note** creates an empty note and opens it on the right.
- Click a note in the list on the left to open it. The list is sorted by last
  modified, newest first, and shows each note's title (its first line, or
  "Untitled" if that's blank), last update date/time, and tags.
- **Tags:** in the bar above the note, type a tag and press Enter; click × to
  remove one. Tags use lowercase letters and digits only (up to 32 characters,
  20 per note). Changing tags doesn't count as an update.
- **Filter:** the dropdown at the top of the list shows only notes with the
  chosen tag. A new note created while filtering gets that tag.
- **«** hides the sidebar and **»** brings it back; the browser remembers which.
- Notes save automatically as you type. The line under the editor shows
  "Saving…", "Saved", or an error if a save failed.
- **Log out** is at the top of the list.

## Day-to-day

| Task              | Command                                          |
|-------------------|--------------------------------------------------|
| Stop              | `docker compose down`                            |
| Start again       | `docker compose up -d`                           |
| View logs         | `docker compose logs -f margin`                  |
| Update to latest  | `git pull && docker compose up -d --build`       |

If Docker starts at boot (`sudo systemctl enable docker`), Margin starts with
it, unless you stopped it with `docker compose down`.

## Data and backups

Everything lives in `./data`:

- `users.json`: usernames and password hashes
- `notes/<username>/<id>.txt`: one plain-text file per note
- `notes/<username>/<id>.json`: that note's tags (only if it has had tags)
- `session_secret`: signs login cookies. Delete it and restart to log everyone out.

To back up, copy the whole `./data` directory. Stopping Margin first
(`docker compose down`) guarantees a consistent copy.

## Troubleshooting

- **Container exits with "Cannot write to /data (EACCES)"**: `./data` isn't
  owned by the user Margin runs as. Do step 1, then
  `sudo chown -R "$(id -u):$(id -g)" data` and start again.
- **`create-user` fails with a permission error**: same cause as above; make
  sure `.env` matches your IDs.
- **`create-user` says "needs an interactive terminal"**: run it directly in a
  terminal, without `-T` and without piping input.
- **`create-user` says `users.lock` is held**: if no other `create-user` is
  running, remove `data/users.lock` and try again.
- **Port 5555 is already in use**: stop whatever is using it, or change the
  left-hand port in `docker-compose.yml` (e.g. `"6000:5555"`).
- **"Too many failed attempts"**: wait 15 minutes, or restart Margin
  (`docker compose restart`) to clear the limit.

## Security

Margin is served over plain HTTP: passwords and notes travel unencrypted on
your network. Use it on a network you trust.
