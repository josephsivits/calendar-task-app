# Calendar Task App

Pomodoro-driven task manager with Markdown-as-DB local storage.

## Run it

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`

## Markdown-as-DB Architecture

All data persists to `localStorage` in markdown format and can be exported/imported as `.md` files for git sync.

### Storage Layout

```
tasks.md              # Active + completed tasks
notes/2026-W14.md     # Weekly notes (one file per ISO week)
notes/2026-W15.md
...
```

### tasks.md format

````markdown
# Tasks

## Active

### T0
- **Description:** Build the login page
- **Time:** 01:24:37 (5077s)
- **Started:** 2026-04-01T10:00:00.000Z
- **Notes:**
```notes
Wire up auth middleware first.
```

## Completed

### 2026-04-01

#### T3
- **Description:** Setup project
- **Time:** 02:10:00 (7800s)
- **Completed:** 2026-04-01T17:00:00.000Z
- **Notes:** (empty)
````

Per-task notepad text lives in a `notes` fenced block (or `(empty)` when blank). Older `tasks.md` files without a Notes field still import with `notes: ""`.

### notes/YYYY-Www.md format

```markdown
# 2026-W14 — Mar 30 – Apr 5, 2026

Your free-form weekly notes here...
```

### Git Sync Workflow

1. Export `.md` files via the Export button
2. Drop them into your git repo
3. `git add . && git commit -m "sync" && git push`
4. On another machine: `git pull`, then Import the `.md` files

### localStorage Keys

| Key | Content |
|-----|---------|
| `md:tasks` | Raw markdown of tasks.md |
| `md:notes:YYYY-Www` | Raw markdown per week |
| `md:settings` | JSON blob (nextTaskId, attachments, etc.) |

## Build

```bash
npm run build
```

Static output in `dist/`.
