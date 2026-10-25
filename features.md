# Margin — Features

## Notes

- Plain text with formatting (like markdown)
- A note's title is its first line
- New note button
- Empty notes are fine

## Formatting

- Color highlighter, bold, underline
- Written inline as `=={options}text==`, options joined with `+`:
  - a color: `=={green}wrist exercises==`, `=={amber-deep}computer that yells at you==`
  - bold: `=={b}together==`
  - underline: `=={u}duplicates==`
  - combined: `=={lime+b+u}yearbook==`
- Two modes:
  - Raw mode: you see all the raw formatting
  - Render mode: you just see the colors, underline and bold
- A menu bar with the formatting options, laid out like this popup:
  - **B** (bold) and **U** (underline) toggles, and **Clear formatting**
  - **Remove colour**
  - a grid of color swatches, each showing a sample "a"
  - hint at the bottom: "Enter applies · Esc closes"
- 10 highlight colors:

  | Name         | Color     |
  |--------------|-----------|
  | `yellow`     | `#fff3a3` |
  | `amber`      | `#ffe08a` |
  | `amber-deep` | `#ffc94d` |
  | `orange`     | `#ffd2a8` |
  | `red`        | `#ffc2c2` |
  | `pink`       | `#ffc8e6` |
  | `purple`     | `#e2d1ff` |
  | `blue`       | `#c8e0ff` |
  | `green`      | `#c6f0c9` |
  | `lime`       | `#def7a6` |

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
