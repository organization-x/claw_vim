# Multi-session plan

Layer multiple Claude sessions onto claude-vim. Each session works in its own
git worktree (real filesystem isolation, its own branch). The left pane shows
**that session's** changed files pinned above the full tree. The right pane is
a tab bar of sessions, each tab a live PTY with its own status color.
File-level + line-level edit highlights show what each session has changed
since it started.

## Decisions locked in

| Question | Choice |
|---|---|
| Isolation | **Git worktree per session** (separate dir + branch) |
| Right-pane layout | **Tabs**, one PTY visible at a time |
| File tree | **Pinned changed-files section + full tree below** |
| Status source | **Claude Code hooks** (UserPromptSubmit / Stop / Notification) |
| Edit highlights | **File-level dots in tree + line-level CodeMirror gutter marks** |
| Persistence | **Ephemeral** — sessions die on app close |
| Session creation | **Blank slate** — no upfront task description |

## Status colors

| State | Color | Trigger |
|---|---|---|
| `fresh` | ⚪ gray | session just created, no prompt yet |
| `idle` | 🟢 green | last event was `Stop` |
| `working` | 🟡 yellow | last event was `UserPromptSubmit` (or any tool use after) |
| `blocked` | 🔵 blue | last event was `Notification` (Claude is asking permission) |
| `error` | 🔴 red | PTY exited unexpectedly |

## Architecture

### Data model (frontend state)

```ts
interface Session {
  id: string;             // ULID
  name: string;           // e.g. "session 1", user-renameable later
  branch: string;         // claude-vim/<id>
  worktree: string;       // absolute path to the worktree dir
  baseSha: string;        // commit SHA the worktree was branched from
  status: "fresh" | "idle" | "working" | "blocked" | "error";
  ptyId: string | null;
  activePath: string | null;
  changedFiles: ChangeEntry[];   // populated from `git status --porcelain`
}

interface ChangeEntry {
  path: string;           // relative to worktree
  status: "modified" | "added" | "deleted" | "untracked";
}
```

The original folder is the "main" workspace. The first session ("main")
is special: no worktree, runs in the original folder, branch = HEAD's branch.
Subsequent sessions get a real worktree.

### Worktree lifecycle

- Open folder → require git (offer `git init` if not a repo).
- Create main session implicitly. Status = `fresh`.
- "+ New session" runs:
  ```
  git worktree add <repo>/.claude-vim/worktrees/<id> -b claude-vim/<id> HEAD
  ```
  We create `.claude-vim/` lazily, ensure `.gitignore` excludes it.
- Close session → `git worktree remove --force <path>` and `git branch -D claude-vim/<id>`.
- App close → close all sessions (best-effort on quit).

### Per-session PTY model

Today: 1 PTY per app. New: 1 PTY per session. Tauri's `PtyState` already
keys by id, so the Rust side needs minimal change. The frontend mounts N
`<Terminal>` components (stable React identity per session) with
`display: none` on inactive ones — preserves scrollback when switching tabs.

### Status detection via Claude Code hooks

For each session worktree, write `<worktree>/.claude/settings.local.json`:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://127.0.0.1:<port>/hook -d 'session=<id>&event=submit&token=<token>' >/dev/null 2>&1 || true"
      }]
    }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "<same shape, event=stop>" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "<same shape, event=notification>" }] }]
  }
}
```

Rust spawns a tiny `tiny-http` (or `axum`) server on a random localhost port
when the app boots. POSTs map (session, event) → status update, which is
forwarded to the frontend via a Tauri event (`session:status`). The token
is a per-launch random string to keep stray browser tabs out.

### Change tracking

Compute changed files for a session via:

```
git -C <worktree> status --porcelain
```

Refresh on:
- file save (we just wrote to disk → cheap to refresh)
- session focus
- a 5-second poll while focused (catches Claude's writes between saves)
- explicit "refresh" button

For line-level marks, when the editor opens a file in a session whose
`baseSha` is known, run:

```
git -C <worktree> diff --unified=0 <baseSha> -- <file>
```

Parse hunks → CodeMirror `RangeSet` of decorations on the gutter
(green for added, blue for modified, red strike for deleted-line markers).
Recompute on save.

### UI changes

- **Top bar above the right pane**: tab strip
  - Tab = colored dot (status) + name + close (×).
  - Trailing "+" creates a session.
  - Right-click tab → rename, close.
- **Left pane**: when a session is active:
  - Header shows session name.
  - Pinned "Changes (N)" section with the changed-files list.
  - Full tree below (scrolls independently, collapsed default).
  - Each changed file in tree gets a colored dot:
    - 🟢 added, 🟡 modified, 🔴 deleted, ⚫ untracked.
- **Editor**: gutter decorations for changed lines (added / modified).
- **Terminal**: identical to today, just one per session, switched by tabs.

## Milestones

| # | Goal |
|---|---|
| **M7.1** | Session data model + tabs UI shell. Single "main" session populated automatically; "+" button creates dummy sessions (no PTY/worktree yet). All existing behavior moves into the active session. |
| **M7.2** | Real worktree creation + cleanup. Sessions get isolated dirs and branches. PTY spawns in the session's cwd. Switching sessions swaps editor cwd, file tree, terminal. |
| **M7.3** | Multiple PTYs in parallel. Render N xterm instances, hide inactive ones. Verify no cross-talk. |
| **M7.4** | Per-session changed-files panel via `git status --porcelain`. Pinned at top of file tree. File-level dots in tree. Refresh on save + 5s poll. |
| **M7.5** | Hooks-based status colors. Local HTTP server in Rust, hook script written into each worktree's `.claude/settings.local.json`. Tab-bar dot reflects status live. |
| **M7.6** | Line-level CodeMirror gutter marks driven by `git diff <baseSha>` per-file. |

Estimate: 8–12 evenings end-to-end. M7.1–M7.3 are the foundation; M7.4–M7.6 layer on top once the model is right.

## Risks / unknowns

- **Worktree on a non-git folder.** If the user picks a non-repo, we offer
  `git init`. If they decline, we fall back to single-session mode (no
  worktree, no isolation). Not great, but acceptable.
- **Hook race condition.** Stop fires after the model finishes; if it fires
  *before* the next `UserPromptSubmit`, we'd flicker green→yellow on every
  prompt. That's actually correct behavior. The risk is hook commands
  failing silently (curl not on PATH in some environments) — mitigation:
  resolve curl path same way we resolve claude.
- **PTY scrollback memory.** N sessions × scrollback = N× memory. With
  scrollback=5000 and 5 sessions, ~25MB worst-case. Fine.
- **Worktree cleanup on crash.** If the app crashes, worktrees pile up.
  v2: scan `.claude-vim/worktrees/` on launch and prune any not in our
  session list. v1: user runs `git worktree prune` manually.
- **Branch name collisions.** ULID prevents real collisions but if someone
  manually deletes the worktree the branch lingers. v2: clean up branches
  too. v1: ignored.

## Open issues for later

- Renaming sessions in the UI.
- Closing a session with uncommitted changes — prompt to commit / discard.
- Merging session branches back into main from the UI.
- Session-aware Cmd+P (search across all sessions' changed files).
- Persistence (`claude --continue`, restored worktrees).
- Side-by-side diff view as a 4th editor view-mode.
