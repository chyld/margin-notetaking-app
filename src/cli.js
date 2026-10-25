'use strict';

// Usage: node src/cli.js create-user <username>

process.umask(0o077);

const fsp = require('node:fs/promises');
const store = require('./store');
const auth = require('./auth');

const PASSWORD_MIN_CHARS = 8;
const PASSWORD_MAX_BYTES = 1024;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Reads lines from the terminal without echoing them. Input is buffered across
// prompts, so pasting both passwords at once works. Escape sequences (arrow
// keys etc.) and other control characters are ignored.
function hiddenInput() {
  const { stdin, stdout } = process;
  const lines = [];
  let current = '';
  let afterCR = false;
  let escape = null; // inside an escape sequence: 'start', 'csi' or 'ss3'
  let waiting = null;

  const close = () => {
    stdin.setRawMode(false);
    stdin.pause();
  };
  const deliver = () => {
    if (!waiting || lines.length === 0) return;
    const resolve = waiting;
    waiting = null;
    stdout.write('\n');
    resolve(lines.shift());
  };

  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', (data) => {
    for (const ch of data) {
      // Skip escape sequences. The state is kept across chunks, since a
      // sequence can be split between two reads.
      if (escape === 'start') {
        escape = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : null;
        continue;
      }
      if (escape === 'csi') {
        if (ch >= '@' && ch <= '~') escape = null;
        continue;
      }
      if (escape === 'ss3') {
        escape = null;
        continue;
      }
      if (ch === '\x1b') {
        escape = 'start';
        continue;
      }
      const wasCR = afterCR;
      afterCR = ch === '\r';
      if (ch === '\u0003' || ch === '\u0004') {
        // Ctrl-C / Ctrl-D: abort.
        close();
        stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\n' && wasCR) continue; // \r\n is one line break
      if (ch === '\r' || ch === '\n') {
        lines.push(current);
        current = '';
      } else if (ch === '\u007f' || ch === '\b') {
        current = [...current].slice(0, -1).join('');
      } else if (ch >= ' ') {
        current += ch;
      }
    }
    deliver();
  });
  stdin.resume();

  return {
    prompt(question) {
      stdout.write(question);
      return new Promise((resolve) => {
        waiting = resolve;
        deliver();
      });
    },
    close,
  };
}

async function createUser(username) {
  if (!username || !store.USERNAME_RE.test(username)) {
    fail('Username must be 1-32 characters: lowercase letters, digits, "_" or "-".');
  }
  if (!process.stdin.isTTY) {
    fail('create-user needs an interactive terminal (run it with "docker compose exec", without -T).');
  }
  if ((await store.readUsers()).has(username)) fail(`User "${username}" already exists.`);

  const input = hiddenInput();
  const password = await input.prompt('Password: ');
  let problem = null;
  if ([...password].length < PASSWORD_MIN_CHARS) problem = `Password must be at least ${PASSWORD_MIN_CHARS} characters.`;
  else if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) problem = 'Password is too long.';
  else if ((await input.prompt('Confirm password: ')) !== password) problem = 'Passwords do not match.';
  input.close();
  if (problem) fail(problem);

  const record = await auth.hashPassword(password);
  await fsp.mkdir(store.NOTES_DIR, { recursive: true, mode: 0o700 });
  // Create the notes directory first so a crash never leaves a user without one.
  await store.ensureUserDir(username);
  await store.withUsersLock(async () => {
    const users = await store.readUsers();
    // Throw rather than exit, so the lock is released.
    if (users.has(username)) throw new Error(`User "${username}" already exists.`);
    users.set(username, record);
    await store.writeUsers(users);
  });
  console.log(`Created user "${username}".`);
}

async function main() {
  const [command, username] = process.argv.slice(2);
  if (command !== 'create-user') fail('Usage: node src/cli.js create-user <username>');
  await createUser(username);
}

main().catch((err) => {
  if (err.code === 'EACCES') {
    fail(
      `${err.message}\nThe CLI runs as MARGIN_UID/MARGIN_GID (default 1000:1000), which must own ./data. ` +
        'Set them in .env as described in the README.',
    );
  }
  fail(err.message);
});
