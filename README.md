# PI Review

**Review, accept, or revert code changes made by the PI agent — right from your browser.**

PI Review is a [PI extension](https://pi.dev) that tracks every file the agent edits, creates, or deletes. It gives you a clean web interface to see what changed, leave line-level comments, accept the good changes, and revert the ones you don't want.

---

## The Problem

When an AI coding agent modifies your code, it happens fast — files change, new code appears, and you're left wondering "what did it just do?" The agent's chat history shows tool calls, but it's hard to get a clear picture of every file change across multiple edits.

PI Review solves this by:

- **Tracking every edit** the agent makes (through `edit`, `write`, or `bash` tools)
- **Showing a unified diff** per file — so you see all changes together, not scattered across tool calls
- **Letting you accept or revert** changes, one file at a time or all at once
- **Preserving a history** of every accept/revert action, so you can go back and review what was done

---

## Main Workflow

### 1. The agent makes changes

When the PI agent edits a file, PI Review automatically captures the original content, the new content, and a diff showing exactly what changed. Nothing extra to do — it just works.

### 2. Open the review UI

Run `/review` in PI to open the web interface. You'll see:

- A **sidebar** listing every file that was changed
- A **main panel** showing the diff for the selected file
- Status badges: **Pending** (yellow), **Accepted** (green), **Reverted** (grey)

### 3. Review changes

For each file you can choose between two views:

- **Diff view** — shows only the changed lines
- **Full file view** — shows the complete file with changes highlighted in green (additions) and red (deletions). A down-arrow button jumps you to the next change.

### 4. Accept or revert

- **Accept** — keeps the agent's changes. Future edits to the same file will diff against the accepted version.
- **Revert** — restores the file to its original content before the agent touched it.

You can do this per file or globally with the "Accept All" / "Revert All" buttons.

### 5. Leave comments

Click any line number to add a comment. Comments are sent to the agent as instructions — useful for asking "why did you change this?" or requesting a fix without leaving the review UI.

### 6. Check history

Every accept or revert is recorded. Files with history show a collapsible list of past cycles, so you can see the full timeline of what happened.

### 7. Talk to the agent

Use the **Chat** button to start an open conversation with the agent. The chat panel slides in from the right — you can resize it by dragging the left edge.

### 8. Reference code

Right-click on any line or selection to open the "Reference this code" menu. This sends the selected code along with a question to the agent.

---

## Key Features

| Feature | Description |
|---|---|
| **File tracking** | Automatically captures changes from `edit`, `write`, and `bash` tools |
| **Unified diffs** | Merges multiple edits to the same file into a single, readable diff |
| **Diff view** | Shows only changed lines |
| **Full file view** | Shows the complete file with inline diff highlighting |
| **Scroll to next diff** | In full file view, jumps to the next changed line |
| **Accept / Revert** | Per-file or global accept/revert with history tracking |
| **Line comments** | Click a line number to leave a comment for the agent |
| **Reference code** | Right-click code to ask the agent about specific lines |
| **Chat** | Open-ended conversation with the agent from inside the review UI |
| **Resizable panels** | Drag the divider between sidebar and main content, or the chat panel edge |
| **History timeline** | Every accept/revert is recorded for future reference |
| **Live updates** | The UI refreshes automatically when new changes come in |
| **Open in VS Code** | Click the VS Code icon to jump straight to a file |
| **External change detection** | Warns when a file was modified outside the agent |

---

## Project Structure

```
pi-review/
├── src/
│   ├── index.ts          — PI extension entry point
│   ├── tracker.ts        — Core engine: tracks, merges, accepts, reverts
│   ├── server.ts         — HTTP server with SSE and REST API
│   ├── types.ts          — TypeScript type definitions
│   └── frontend/
│       ├── app.tsx       — Root Preact component
│       ├── main.tsx      — Frontend entry point
│       ├── store.ts      — API client and SSE manager
│       ├── styles.css    — All styles
│       ├── utils.ts      — Helper functions
│       ├── highlight.ts  — Syntax highlighting
│       ├── selection.ts  — Line selection utilities
│       └── components/
│           ├── file-viewer.tsx      — File diff/full-file display
│           ├── full-file-view.tsx   — Full file with diff highlighting
│           ├── diff-table.tsx       — Unified diff table
│           ├── header.tsx           — Top toolbar
│           ├── sidebar.tsx          — File list sidebar
│           ├── chat-panel.tsx       — Agent chat (slide-in panel)
│           └── reference-panel.tsx  — Code reference panel
├── dist/                — Built frontend assets
├── build.mjs            — esbuild config for frontend
├── package.json         — PI extension config in the `pi` key
└── README.md
```

---

## Installation

PI Review is a PI extension. It's loaded from the `pi` key in `package.json`:

```json
"pi": {
  "extensions": ["./src/index.ts"]
}
```

To use it in another project, either:

```bash
# Install from git
pi install git:github.com/danielmeneses/pi-review

# Or install locally from a local path
pi install /path/to/pi-review -l
```

Extensions and packages are placed in `~/.pi/agent/` (global) or `.pi/` (project-local). See the [PI extensions docs](https://pi.dev) for more details.

---

## Getting Started

```bash
# Build the frontend (required after any UI changes)
npm run build:frontend

# In PI, start the review UI
/review
```

The server picks a port at runtime (defaults to 3123, falls back to a random port if busy). Run `/review` to open it in your browser.

---

## Commands

| PI Command | Description |
|---|---|
| `/review` | Open the review UI in your browser |
| `/accept-all` | Accept all pending changes |
| `/revert-all` | Revert all pending changes (with confirmation) |

---

## State Persistence

PI Review saves its state to `.pi-review/state.json` in your project root. This means:

- Changes survive PI restarts
- You can close and reopen the review UI without losing data
- Accepted/reverted history is preserved between sessions

---

## Requirements

- Node.js 18+
- PI coding agent
- A modern browser (Chrome, Firefox, Safari 14+)
