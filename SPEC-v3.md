# Margin v3 — Spec: save on demand

Builds on v2 (see SPEC-v2.md and ARCHITECTURE.md). Everything not mentioned
here stays as it is.

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

Defaults (the user didn't object):

- A failed save is not retried automatically; the error is shown and the user
  clicks Save again.
- The status line under the editor stays ("Unsaved changes", "Saving…",
  "Saved", "Not saved: …").

## What is removed

All automatic text saving:

- the 500 ms save after typing stops;
- saving before switching notes, creating a note, or logging out;
- saving when the tab is hidden (`visibilitychange`);
- the `keepalive` save on `pagehide`;
- the 3 s automatic retry after a failed save;
- the automatic re-save after a `stale` response.

Tag saving (immediate, `keepalive`, its own sequence numbers) is unchanged.

## Saving

- **Save** (button or shortcut) saves the open note's current text with the
  existing `PUT /api/notes/:id` (same writer/sequence headers, same server).
- Saves still go through the existing chain, so they never overlap or arrive
  out of order. Pressing Save while a save is in flight queues one more save,
  which runs after it and only sends anything if the text still differs from
  what the server confirmed.
- "Unsaved" keeps its v2 meaning: the editor differs from the text the server
  last confirmed, or a save is in flight.
- After a save succeeds, the list entry's title and date update as today.
- **Failed save:** the text stays in the editor, the status line says why
  (as today: logged out, over 1 MB, network/timeout, server error), and the
  button shows the error state until the next save attempt.
- **`stale` response** (can still happen in theory, e.g. after a timed-out
  save): the text is not treated as confirmed; the note stays unsaved.

## Save button

In the menu bar, at the right end (after the tags and tag input).

| State   | When                                          | Look                       | Clickable |
|---------|-----------------------------------------------|----------------------------|-----------|
| none    | no note open                                  | grey, disabled             | no        |
| saved   | nothing to save                               | grey, label "Saved"        | no        |
| unsaved | the editor differs from the saved text        | amber, label "Save"        | yes       |
| saving  | a save is in flight                           | amber, muted, "Saving…"    | no        |
| failed  | the last save failed and the text is unsaved  | red, label "Save"          | yes       |

- Label text changes as well as color, so the state doesn't rely on color
  alone. `title`: "Save (Ctrl+S)" or "Save (⌘S)" on macOS.
- Typing after a failed save keeps the failed (red) state until the next
  attempt, so the failure stays visible.

## Ctrl+S / ⌘S

- While the notes view is shown, Ctrl+S (or ⌘S on macOS) saves, wherever the
  focus is (textarea, tag input, sidebar). The browser's own "Save page"
  action is always suppressed there.
- With no note open or nothing to save, it does nothing (still suppressed).
- On the login form it isn't intercepted.

## Prompting before losing changes

- **Switching notes, New note, Log out:** these first wait for any in-flight
  text save and tag save. Then, if the note is unsaved, the browser asks
  `confirm("You have unsaved changes in this note. Discard them?")`.
  - OK: the changes are discarded and the action goes ahead.
  - Cancel: nothing happens; the note stays open with its changes.
- **Closing or reloading the tab, or navigating away:** if the note is
  unsaved, `beforeunload` makes the browser show its standard "Leave site?"
  prompt. (Browsers don't allow custom text there.)
- An in-flight tag save doesn't trigger a prompt (it is `keepalive` and
  completes on its own).
- While a switch/create/logout is running, the editor is read-only and the
  tag controls and Save are locked, as in v2.

## Docs

README (using Margin: Save button, Ctrl+S, prompts) and ARCHITECTURE.md
(frontend: saving) are updated in the same change.

## Out of scope

Autosave of any kind, drafts kept in the browser, other keyboard shortcuts,
undo of a discard.
