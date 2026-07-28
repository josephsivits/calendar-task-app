# Calendar Task App

Pomodoro-driven task manager with Markdown-as-DB local storage.

## Run it

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`

```bash
npm run build
```

Static output in `dist/`.

---

## User guide

The app is four columns:

| Column | Purpose |
|--------|---------|
| **Tasks** | Active tasks — select one to track time against it |
| **Widgets** | Date, play/pause, sync, calendar, 300s timer, Pomodoro |
| **Attachments & Notes** | Weekly images + free-form weekly notes; Export / Import |
| **Completed** | Tasks completed on the selected calendar date |

### Typical flow

1. **+ Add Task**, then double-click the description to name it.
2. Click the task card (or Tab to it and press Enter) so it’s selected.
3. Press **▶** to start the timer — time accrues on the selected task.
4. Use **▼** on a task to open its notepad for details.
5. When done, press **✓** on the card and confirm **Complete** (Enter works).
6. Press **SYNC** (or wait for auto-save) so work is written to `localStorage`.
7. **Export** a zip when you want a git-friendly markdown backup.

### Timers

One play/pause controls both timers.

| Timer | Behavior |
|-------|----------|
| **300s Timer** | Counts 0→300, then chimes and loops. Grid of 300 dots fills as it runs. |
| **Pomodoro Focus** | 25 minutes. On finish: chime, count increments, phase becomes **Break Pending**. |
| **Pomodoro Break** | Press **▶** again to start the 5-minute break. On finish: chime, back to Focus. |

Time on task only increases while the timer is running **and** a task is selected.

### Notes & attachments

- **Per-task notes** — ▼ on an active or completed card.
- **Weekly notes** — free-form markdown for the ISO week of the selected date.
- **Attachments** — PNG/JPEG only, stored per week in the browser (not included in export zip).
- Changing the calendar date/week saves the current week’s notes and attachments, then loads the new week.

### Completing tasks

Completing always files the task under **today’s date**, even if another day is selected on the calendar. The Completed column filters by the selected date.

---

## Controls

### Tasks

| Control | Action |
|---------|--------|
| Click card | Select task (bright green) |
| Drag card | Reorder active list |
| Double-click description | Edit name (Enter saves, Escape cancels) |
| ▼ | Expand / collapse task notepad |
| ✓ | Complete task (confirm dialog) |
| ✕ | Delete task (confirm dialog) |
| + Add Task | Create task and start editing description |

### Widgets

| Control | Action |
|---------|--------|
| today | Jump to today’s date |
| ▶ / ⏸ | Start / pause timers (also syncs) |
| SYNC / SYNCED | Manual save; orange when dirty, green when clean |
| ◂ / ▸ | Previous / next calendar month |
| Calendar day | Select date |
| Date input | Jump to a specific date |

Calendar: selected day is solid orange; selected week is tinted orange; current week is tinted blue. Weeks start Monday.

### Attachments & Notes

| Control | Action |
|---------|--------|
| Upload zone | Add PNG/JPEG for the current week |
| Attachment card | Select (blue highlight) |
| Thumbnail / preview | Open zoom (− / + from 0.25×–4×) |
| Double-click filename | Rename |
| ✕ on attachment | Delete (confirm dialog) |
| Weekly notes | Edit notes for the current ISO week |
| Preview | Rendered weekly notes + raw `tasks.md` |
| ↓ Export | Download `calendar-export.zip` |
| ↑ Import | Open zip and/or `.md` files |

### Dialogs

| Dialog | Default focus | Confirm | Dismiss |
|--------|---------------|---------|---------|
| Complete task | Complete | Moves task to Completed (today) | Cancel, overlay click, Escape |
| Delete task | Cancel | Removes task permanently | Cancel, overlay click, Escape |
| Delete attachment | Cancel | Removes attachment | Cancel, overlay click, Escape |

---

## Keyboard

| Context | Keys |
|---------|------|
| Anywhere (not typing) | **← / →** — move focus between columns (Tasks → Widgets → Attachments → Completed) |
| Tasks list | **↑ / ↓** — move highlight cursor between cards; **Enter** / **Space** — select the highlighted card |
| Attachments / Completed lists | **↑ / ↓** — move between cards (selects the highlighted attachment) |
| Focused card | **Tab** — reach that card’s action buttons only (other cards are skipped) |
| Card / button focused | **Enter** or **Space** — activate |
| Confirm dialogs | **Tab** cycles Cancel / Confirm; **Enter** activates focused button; **Escape** cancels |
| Description edit | **Enter** saves; **Escape** cancels without saving |
| Attachment rename | **Enter** saves |
| Text fields | Arrow keys move the caret as usual |

The active column gets a subtle orange inset highlight. Focus rings use an orange outline.

---

## Export & import

### Export

**↓ Export** writes `calendar-export.zip`:

```
tasks.md
notes/2026-W14.md
notes/2026-W15.md
...
```

Attachments stay in `localStorage` only and are not zipped.

### Import

**↑ Import** accepts:

- `calendar-export.zip` (full restore of tasks + weekly notes), or
- one or more `.md` files (`tasks.md`, `notes/YYYY-Www.md`, or bare `YYYY-Www.md`)

### Git sync workflow

1. Export `calendar-export.zip`
2. Unzip into your git repo (or commit the zip)
3. `git add . && git commit -m "sync" && git push`
4. On another machine: `git pull`, then Import the zip or the `.md` files

---

## Markdown-as-DB Architecture

All data persists to `localStorage` in markdown format and can be exported/imported as `.md` files for git sync.

Auto-save runs every **10 seconds** when dirty, on Sync, on play/pause, and on tab close.

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

### localStorage Keys

| Key | Content |
|-----|---------|
| `md:tasks` | Raw markdown of tasks.md |
| `md:notes:YYYY-Www` | Raw markdown per week |
| `md:attachments:YYYY-Www` | JSON attachments (data URIs) for the week |
| `md:settings` | JSON blob (`nextTaskId`, `nextAttId`, `pomodoroCount`) |
