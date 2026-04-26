# claude-vim — implementation plan

A simple desktop app: vim editor on the left (TypeScript / Python / Markdown with preview), Claude CLI in a terminal on the right.

## Stack

- **Tauri 2** (Rust shell) + **Vite + React + TypeScript** frontend
- **CodeMirror 6** + `@replit/codemirror-vim` for the editor
- **xterm.js** + **portable-pty** (Rust) for the Claude terminal
- **react-markdown** + `remark-gfm` + `rehype-highlight` for `.md` preview
- **react-resizable-panels** for the split layout

## File structure

```
claude_vim/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── pty.rs          # spawn `claude`, stream stdout, write stdin, resize
│   │   └── fs.rs           # open_file, save_file, read_dir, pick_folder
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── main.tsx
│   ├── App.tsx             # 3-pane layout: tree | editor(+preview) | terminal
│   ├── components/
│   │   ├── Editor.tsx      # CodeMirror + vim + lang autodetect
│   │   ├── MarkdownPreview.tsx
│   │   ├── Terminal.tsx    # xterm.js bound to PTY events
│   │   └── FileTree.tsx
│   ├── hooks/
│   │   ├── useFile.ts      # load/save/dirty tracking
│   │   └── usePty.ts       # subscribe to pty events, send input
│   ├── lang.ts             # ext → CodeMirror LanguageSupport
│   └── styles.css
├── index.html
├── package.json
└── vite.config.ts
```

## Key technical decisions

1. **PTY bridge** — Rust spawns `claude` with `portable-pty`, sets `TERM=xterm-256color`, `cwd` = opened folder. Three Tauri commands: `pty_spawn`, `pty_write`, `pty_resize`. One event channel: `pty:data` (Rust → JS).

2. **Vim `:w` saves the file** — CodeMirror's vim plugin exposes `Vim.defineEx("write", "w", () => save())`. Cmd+S also works.

3. **Markdown preview** — auto-splits the editor pane vertically when a `.md` file is open; toggle button to collapse. Live-updates on a 150ms debounce.

4. **Working directory** — opening a folder sets the cwd for `claude` and roots the file tree. If a folder is already open, switching it kills + respawns the PTY.

5. **`claude` PATH discovery** — GUI-launched apps on macOS don't inherit shell PATH. At startup, resolve via login shell once and cache: `Command::new("zsh").arg("-l").arg("-c").arg("which claude")`. If missing, show a setup screen with install instructions.

## Opening files (single-file editor for v1)

Three actions:

- **File tree click** (leftmost pane). Dirty-buffer prompt: save / discard / cancel.
- **Cmd+P fuzzy finder** — popover matching filenames in the open folder (`fuse.js` or similar).
- **Vim `:e path`** — `Vim.defineEx("edit", "e", ...)`, with path tab-completion.

## Editor ↔ Claude bridge

Claude already has filesystem access via its own `Read` tool, so we don't auto-push file content. Instead:

- **Cmd+L** (or button in editor header) → types `@<relative/path>` into the terminal at the current prompt. `claude` natively understands `@`-mentions and will read the file.
- **With visual selection** → Cmd+L pastes the selected lines as a quoted block instead of the `@`-mention. (M6 nice-to-have.)
- **On save** → no notification; next time Claude reads the file, it sees the new version. Live-streaming edits would be noise.

## Milestones

| # | Goal | Done when |
|---|------|-----------|
| **M1** | Skeleton | Tauri app launches with a 3-pane layout, hardcoded content in each pane |
| **M2** | Vim editor | Editor has vim mode + TS / Python / Markdown highlighting based on file extension |
| **M3** | File I/O | Open folder → tree → click file loads → edit → `:w` or Cmd+S saves; Cmd+P fuzzy open; `:e` ex-command; dirty-buffer guard |
| **M4** | Markdown preview | Opening `.md` shows live preview alongside source; toggle hides it |
| **M5** | Claude terminal | Right pane runs `claude` in the project folder; input + output work; resize works; login-shell PATH resolution |
| **M5.5** | Editor ↔ Claude | Cmd+L sends `@path` (or selected lines) to the terminal |
| **M6** | Polish & ship | Dark theme (CodeMirror `oneDark` + matching xterm.js theme), signed `.dmg` build, restart-Claude button, remember last folder, dirty-state indicator |

Estimate: ~5–7 evenings for M1–M5.5. M6 ongoing.

## Bundling

- `tauri build` produces `.dmg` and `.app` on macOS out of the box.
- Unsigned local distribution: works as-is.
- Signed + notarized (no "unidentified developer" warning): requires Apple Developer ID. Flag this near M6.

## Theme

Dark, v1. CodeMirror `oneDark` for the editor, matching xterm.js theme for the terminal, neutral dark chrome (CSS custom properties so we can swap later).

## Risks

- **TUI rendering fidelity** — `claude`'s prompt UI may render oddly in xterm.js. Mitigation: test early in M5; set `COLORTERM=truecolor` and a generous default size.
- **Vim ex-command hook** — `Vim.defineEx` works but is sparsely documented. If it breaks, fall back to Cmd+S only.
- **Claude binary path on macOS GUI launches** — addressed above via login-shell resolution.

## Deferred (not v1)

- Multi-file tabs
- Search across files
- Git integration in the UI
- Settings panel (font size, theme switcher, keybindings)
- Windows / Linux builds
