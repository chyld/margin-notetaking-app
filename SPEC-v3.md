# Margin v3 — Spec: save on demand

Builds on v2 (see SPEC-v2.md and ARCHITECTURE.md). Everything not mentioned
here stays as it is. Revised after beta's spec review (7 reviewers).

## Features (from the user; nothing else is in scope)

1. No autosave: a note's text is saved only on demand.
2. A **Save** button in the menu bar.
3. The Save button is colored according to its state.
4. **Ctrl+S** saves (⌘S on macOS).
5. The browser always prompts before changes would be lost.
6. Tags keep saving automatically when changed (unchanged from v2).

## Decisions

From the user:

- Always prompt when about to lose changes (switching notes, New note, Log
  out, closing or reloading the tab).
- Tags auto-save as in v2.
- Color the Save button by state.
- Ctrl+S saves.

Defaults (not raised by the user):

- A failed save is not retried automatically; the user presses Save again.
- The status line under the editor stays.
- No queueing: pressing Save while a save is in flight does nothing. Text
  typed during a save leaves the note unsaved afterwards, and Save is pressed
  again.
- A half-typed tag in the tag input counts as an unsaved change for the
  prompts (it would otherwise be lost silently).

Known limit (pending the user's decision; see the end): the "Leave site?"
prompt depends on the browser. Desktop browsers show it; mobile browsers often
don't (iOS Safari, a tab killed in the background), and a crash never does.
With no autosave, unsaved text exists only in that tab, so it can be lost
there without a prompt. This is documented in the README.

## What is removed

All automatic text saving and the code that only served it:

- the 500 ms save after typing (`SAVE_DELAY_MS`, `saveTimer` and every
  `clearTimeout(saveTimer)`);
- saving before switching notes, creating a note, or logging out (the
  `await save()` in `exclusive()`, the `saved` argument, the
  `if (!saved) return` checks, and logout's own confirm);
- the `visibilitychange` save;
- the `pagehide` keepalive save;
- the 3 s automatic retry and its "Retrying…" text (`RETRY_DELAY_MS`);
- the automatic re-save after a `stale` response;
- the `beforeunload` 60 KiB size condition and `KEEPALIVE_MAX_BYTES`
  (the prompt now covers notes of any size).

Tag saving (immediate, `keepalive`, its own sequence numbers) is unchanged.

## Save state

The client keeps, for the open note:

- `savedText`: the text the server last confirmed (as in v2);
- `saving`: a text save is in flight (as in v2);
- `saveFailed`: the last save attempt failed. Set on any failure; cleared by
  a successful save, by opening or creating a note, and on logout/login.

**Unsaved** = a note is open and (`saving` or `saveFailed` or the editor text
differs from `savedText`). `saveFailed` counts even if the text was edited
back to `savedText`: after a timeout or network error the server may hold the
failed text, so the note isn't known to be clean until a save succeeds.

**Save** is possible when a note is open, nothing is locked, no save is in
flight, and the note is unsaved. It sends the editor's current text with the
existing `PUT /api/notes/:id` (same writer/sequence headers).

- **Success:** `savedText` = the sent text, `saveFailed` cleared, the list
  entry's title/date update. If the editor changed during the save, the note
  is unsaved again.
- **Failure:** the text stays in the editor, `saveFailed` is set, the status
  line shows "Not saved: …" in red:
  - 401: "Not saved: you've been logged out. Log in again in another tab, then
    press Save again." (The session cookie is shared, so this works.)
  - 413: "Not saved: this note is over 1 MB. Remove some text, then press Save
    again."
  - network error, timeout, other: "Not saved: <reason>. Press Save to try
    again."
- **`stale` response** (defensive; with saves serialized and no page-close
  save it shouldn't happen): treated like a failure — the note stays unsaved,
  and the stale response's title/date are **not** applied to the list.
- While `saveFailed` is set, typing does not replace the red "Not saved: …"
  message; it stays until the next save attempt.

## Save button

The last item in the menu bar, pushed to the right edge (`margin-left: auto`).
The state is computed in one function, called on input, save start, save end,
opening/creating a note, lock/unlock, and reset. First match wins:

| # | State   | When                      | Label       | Look                        | Activation                |
|---|---------|---------------------------|-------------|-----------------------------|---------------------------|
| 1 | none    | no note open              | "Save"      | grey                        | native `disabled`         |
| 2 | locked  | switch/create/logout runs | (unchanged) | dimmed (existing busy style)| native `disabled`         |
| 3 | saving  | a save is in flight       | "Saving…"   | amber, muted                | `aria-disabled`, ignored  |
| 4 | failed  | `saveFailed`              | "Save again"| red, white text             | clickable                 |
| 5 | unsaved | text differs              | "Save"      | amber, dark text            | clickable                 |
| 6 | saved   | otherwise                 | "Saved"     | grey                        | `aria-disabled`, ignored  |

- States 3 and 6 use `aria-disabled="true"` with clicks ignored, not
  `disabled`, so a focused button keeps focus and its new label is announced.
- Every state has a distinct label, so none relies on color alone.
- A fixed `min-width` keeps the menu bar from shifting as the label changes.
- `title` and `aria-keyshortcuts`: "Save (⌘S)" / `Meta+S` on Apple devices
  (`/Mac|iPhone|iPad/` in `navigator.userAgent`), otherwise "Save (Ctrl+S)" /
  `Control+S`. This only affects the hint, never which keys work.

## Ctrl+S / ⌘S

One `keydown` listener on `document`:

1. If the login view is shown, do nothing (the event is not intercepted).
2. Match: (`ctrlKey` or `metaKey`), no `altKey`, no `shiftKey` (so AltGr
   characters and Ctrl+Shift+S are left alone), and (`code === 'KeyS'` or
   `key.toLowerCase() === 's'`), so Caps Lock and non-Latin layouts work.
   Both Ctrl and ⌘ are accepted on every platform.
3. On a match, always `preventDefault()` (the browser's "Save page" never
   opens in the notes view).
4. Then ignore it if `event.repeat`, `event.isComposing`, or Save isn't
   possible (no note, locked, saving, nothing to save). Otherwise save.

## Prompting before losing changes

**Changes that can be lost** = the note is unsaved (above) or the tag input
contains text.

### Switching notes, New note, Log out

`exclusive()` becomes:

1. If already locked, ignore. Otherwise lock (editor read-only, tag controls,
   Save button and Ctrl+S locked), so no new save can start.
2. Wait for the in-flight text save and tag save to settle. Never start a
   save.
3. If there are changes that can be lost:
   `confirm("You have unsaved changes in this note. Discard them?")`.
   Cancel: unlock; nothing else happens. OK: continue.
4. Run the action, then unlock.

There is one confirm for all three actions. Discarding can't be undone.

### Closing, reloading, navigating away

```js
window.addEventListener('beforeunload', (event) => {
  if (!hasChangesThatCanBeLost()) return;
  event.preventDefault();
  event.returnValue = true; // older browsers / Firefox and Safari need this
});
```

The prompt also appears while a save is in flight, because leaving cancels
that request.

### Logged out (401)

A 401 never clears text that could be lost. Today any 401 routed through
`showError()` calls `showLogin()`, which empties the editor. In v3, on a 401:

- if there are changes that can be lost, stay on the notes view and show the
  logged-out message in the status line (the editor keeps the text);
- otherwise show the login form as today.

(Inside `exclusive()`, a 401 after the user confirmed a discard goes to the
login form as today, since the changes were already discarded.)

## Docs

- README: Using Margin (Save button, Ctrl+S/⌘S, prompts, discarding can't be
  undone, the mobile limit).
- ARCHITECTURE.md: the feature/decision list at the top (a v3 line like v2's),
  Frontend bullets "Autosave", "Closing the page", "Failed saves", "Switch /
  new note / logout", the `stale` bullet, and the menu bar.

## Out of scope

Autosave of any kind (including a page-close save), drafts kept in the
browser, other keyboard shortcuts, undo of a discard.

## Open question for the user

Mobile browsers may close a tab without the "Leave site?" prompt, losing
unsaved text. The only way to protect that case is a save when the page is
hidden or closed, which is a form of autosave. Default: accept the limit and
document it.
