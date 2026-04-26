# claude-vim

A desktop code editor that pairs a vim-keybinded buffer with a built-in
[Claude Code](https://docs.claude.com/en/docs/claude-code) terminal — and lets
you run multiple Claude sessions in parallel on the same repo via git
worktrees.

Built with [Tauri 2](https://tauri.app), React, and Rust.

## What you get

- **Vim-keybinded editor** — CodeMirror 6 + `@replit/codemirror-vim`, with
  syntax highlighting for JS/TS, Python, and Markdown.
- **Embedded Claude Code terminal** — a real PTY (via `portable-pty`) running
  `claude` in your repo. Output streams to xterm.js.
- **Multi-session via git worktrees** — each extra session gets its own
  worktree on a fresh branch, so you can run several Claude instances
  concurrently without their edits stepping on each other. The "main" tab
  works on the repo root.
- **Live status dots** — Claude Code hooks call back into the app so each tab
  shows whether that session is fresh / working / idle / blocked / errored.
- **Changes panel + diff gutter** — git status per session, plus an
  added/modified gutter in the editor showing what's changed since the
  session's base SHA.
- **Markdown preview** with GFM, syntax highlighting, and Mermaid diagrams.
- **Fuzzy file finder** — `Cmd/Ctrl+P`.
- **Send file to Claude** — `Cmd/Ctrl+L` types `@<relative-path>` into the
  active terminal.
- **First-launch system check** — verifies `claude` and `git` are on PATH and
  walks you through install if not.

## Requirements

- macOS (the app targets `darwin`; Linux/Windows are likely close but
  untested).
- [Rust toolchain](https://rustup.rs) (for Tauri).
- Node.js 18+ and npm.
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup) on
  your PATH (`npm install -g @anthropic-ai/claude-code`). The app will prompt
  you on first launch if it's missing.
- Git.

## Install

Prebuilt macOS bundles are published on GitHub:
[organization-x/claw_vim releases](https://github.com/organization-x/claw_vim/releases).

Grab the latest `.dmg`, open it, and drag **claude-vim** into `/Applications`.
On first launch macOS may complain that the app is from an unidentified
developer — right-click the app and choose **Open** to bypass Gatekeeper once.

You'll still need the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup)
on your PATH; the app will walk you through installing it on first launch if
it's missing.

## Run from source

```bash
npm install
npm run tauri dev
```

To build a distributable bundle yourself:

```bash
npm run tauri build
```

The bundle is written under `src-tauri/target/release/bundle/` — the macOS
`.dmg` lands in `src-tauri/target/release/bundle/dmg/`.

## Using it

1. Launch the app and pick a folder. If it isn't a git repo, you'll be
   prompted to `git init`, open it single-session, or cancel.
2. The main session opens on the repo root. Click `+` in the tab strip to
   spin up another session — that creates a worktree on a new branch.
3. Open files via the file tree (left), the Changes panel, or `Cmd/Ctrl+P`.
4. Edit in the buffer (vim keys); save with `:w`. The terminal on the right
   runs Claude in that session's working directory.
5. `Cmd/Ctrl+L` in the editor sends `@<path>` into Claude so you can quickly
   reference the open file.

## Modifying it

The codebase is split cleanly between the React frontend and the Rust
backend.

### Frontend — `src/`

```
src/
├── App.tsx              root component; owns the session model
├── App.css              all styling (single stylesheet)
├── types.ts             shared TS types (Session, TreeNode, …)
├── lang.ts              CodeMirror language extension picker
└── components/
    ├── Editor.tsx        CodeMirror + vim
    ├── Terminal.tsx      xterm.js wired to the Rust PTY
    ├── FileTree.tsx
    ├── SessionTabs.tsx
    ├── FuzzyFinder.tsx
    ├── MarkdownPreview.tsx
    ├── Mermaid.tsx
    ├── DirtyPrompt.tsx
    ├── RepoInitPrompt.tsx
    └── SetupScreen.tsx
```

The session model (one editor + one terminal + one worktree) lives in
`App.tsx`. The header comment there is the best starting point — it
documents how sessions, the dirty-buffer model, and the hooks server fit
together.

### Backend — `src-tauri/src/`

```
fs.rs       read_dir_tree, read_file_text, write_file_text
git.rs      repo check, init, worktree add/remove, status, per-file diff
pty.rs      spawn / write / resize / kill PTYs; locate the `claude` binary
hooks.rs    HTTP server Claude Code calls back into for status events
setup.rs    first-launch system check (claude + git on PATH)
lib.rs      registers all commands with Tauri
```

### Adding a new feature

The frontend talks to Rust through `invoke("<command_name>", { … })`. To add
a new command:

1. Write the function in the appropriate `src-tauri/src/*.rs` module,
   annotated with `#[tauri::command]`.
2. Register it in `src-tauri/src/lib.rs` inside `invoke_handler![…]`.
3. Call it from the frontend with `invoke<ReturnType>("name", args)`.

For events flowing the other way (Rust → frontend), emit with
`app.emit("…")` and listen with `listen("…", …)` on the JS side — see
`session:status` in `hooks.rs` and `App.tsx` for a worked example.

### Styling

All CSS is in `src/App.css`. There's no design system or component library —
just plain class names matched to the components.

### Config

- `src-tauri/tauri.conf.json` — window size, bundle identifier, app version.
- `src-tauri/capabilities/` — Tauri permissions allowed to the webview.
- `package.json` — frontend deps and the `tauri` script.

## Project layout

```
.
├── src/                 React + TS frontend
├── src-tauri/           Rust backend + Tauri config
├── public/              static assets bundled into the webview
├── PLAN*.md             design notes (sessions, merge, context)
├── index.html           Vite entry
└── vite.config.ts
```

The `PLAN*.md` files capture the original design thinking for sessions,
merges, and context handling — they're not load-bearing for the build, but
they're useful background if you're touching those subsystems.
