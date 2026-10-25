# Margin — Features

## Notes

- Plain text only (no markdown)
- A note's title is its first line
- New note button
- Empty notes are fine

## Saving

- Saved only on demand (no autosave)
- Save button in the menu bar, colored by state
- Ctrl+S saves
- The browser prompts before changes would be lost
- Two tabs on the same note: the most recent update wins

## Layout and sidebar

- Note list on the left, open note on the right
- Collapsible sidebar
- List sorted by last modified
- Each note shows its title, last update date/time (smaller), and tags

## Tags

- Added in a menu bar at the top of the note
- Lowercase, no spaces, only a-z and 0-9
- Saved automatically when changed
- Dropdown at the top of the sidebar filters the list by tag

## Links

- Bookmark a note or a tag (one or the other, never both)
- Links use `?` in the URL
- Note ids are 8 characters, a-z and 0-9
- Examples:
  - `http://localhost:5555/?note=k3x9q2mf`
  - `http://localhost:5555/?tag=work`
- Logged out: log in first
- Not found: 404
- Back and Forward are ignored

## Users

- For fewer than 5 users
- Multiple users, created with a CLI tool
- Logout button

## Setup

- Called Margin
- Docker Compose
- No database; everything is stored in files
- Full network access on port 5555, plain HTTP
- README with install and setup instructions
- Favicon
