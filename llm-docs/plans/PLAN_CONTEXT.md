# Context inspector plan

A bottom drawer below the editor + terminal that shows what's actually in the
active session's Claude context — files loaded, tokens spent, MCP tools, recent
turns — with one-click actions next to every item so the user can pin, eject,
fork, rewind, or snapshot without leaving the app. Toggleable like VS Code's
terminal drawer.

This solves the wishlist's #4 ("see exactly what's in context right now") and #5
("pin / lock files into context"), plus the auto-compact data-loss pain (top
GitHub complaint) by offering a snapshot-before-compact gate.

## Decisions locked in

| Question | Choice |
|---|---|
| Location | **Bottom drawer**, full-width, resizable, below editor + terminal |
| Toggle | **Cmd+J** (matches VS Code), persisted per-session in localStorage |
| Default state | **Collapsed to 1-line strip** showing tokens / cost / status |
| Data source | **Read JSONL transcript on disk** at `~/.claude/projects/<slug>/<sid>.jsonl` |
| Update trigger | **`PostToolUse` + `Stop` + `PreCompact` hooks** — extends existing endpoint |
| Per-session scope | **One drawer state per session** — switching tabs swaps content |
| Action surface | **Inline icons next to each row + global toolbar at top of drawer** |
| Pin mechanism | **Per-session pin list** stored in `<worktree>/.claude-vim/pins.json`, re-injected via UserPromptSubmit hook prefix |
| Snapshot format | **Markdown bundle** — transcript + diff + pinned files, written to `<worktree>/.claude-vim/snapshots/<timestamp>/` |
| Eject mechanism | **Ephemeral note** added to next user prompt: "Don't re-read X" — no Claude API surface for "eject from cache" |

## Why "actions next to data" matters

A read-only context viewer is information without leverage. Every item the user
sees raises a question: *do I want to keep this? swap it? snapshot it?* Forcing
them to context-switch back to the terminal to type `/clear` or paste a CLAUDE.md
reminder breaks the loop. The drawer's job is to make the answer to "what should
I do about this?" one click away.

Three action tiers:

1. **Per-row** — small icon cluster next to each loaded file / turn / tool.
2. **Per-section** — buttons in section header (e.g. "Eject all stale files").
3. **Global** — toolbar at the top of the drawer (snapshot, fork, rewind, compact).

## Architecture

### Drawer layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ▾ CONTEXT       155k / 200k  $1.42  cache 87%      💾 🍴 ↩ 📤 🗜 ⚙     │  ← 1-line strip (always visible)
├─────────────────────────────────────────────────────────────────────────┤
│ [Files (12)] [Tools (4)] [Memory] [Turns (38)]   ← tabs                 │
├─────────────────────────────────────────────────────────────────────────┤
│ 📌 src/components/SessionTabs.tsx       412 lines  ~3.1k tok   ✕ 👁 ↺  │
│    src-tauri/src/hooks.rs               289 lines  ~2.2k tok  📌 ✕ 👁 ↺ │
│    PLAN_SESSIONS.md                     182 lines  ~1.4k tok  📌 ✕ 👁 ↺ │
│    package.json                          38 lines  ~0.3k tok  📌 ✕ 👁 ↺ │
│    ...                                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

When collapsed: just the 1-line strip. Click ▾ or Cmd+J to expand.

### Strip metrics (always visible, even collapsed)

| Field | Source | Update trigger |
|---|---|---|
| `tokens_used / context_max` | sum of latest assistant turn's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | PostToolUse, Stop |
| `$cost` | sum of `(input * $/M-in) + (output * $/M-out) + (cache_create * $/M-cc)` per turn, using model from JSONL | PostToolUse |
| `cache hit %` | `cache_read / (cache_read + cache_creation + input)` over last 10 turns | Stop |
| `status dot` | reuses M7.5 status — green/yellow/blue/red | already wired |

### Tabs (inside drawer)

**1. Files** — every path Claude has Read/Edit/Write'd this session.

| Per-row info | Per-row action |
|---|---|
| Path (relative) | 📌 Pin (re-inject after compact) |
| Lines + estimated tokens | ✕ Eject (next prompt: "don't re-read X") |
| Last accessed turn # | 👁 Open in editor (left pane) |
| Pin marker if pinned | ↺ Refresh (write current disk version into next user prompt) |

**2. Tools** — MCP servers + built-in tools currently loaded.

| Per-row info | Per-row action |
|---|---|
| Server / tool name | ⏸ Disable for this session (writes to `.claude/settings.local.json` `disabledMcpjsonServers` and prompts user to /restart) |
| Tool count + token weight (from system prompt analysis) | 📋 Copy server config |
| Status (connected / failed) | 🔧 Edit config (opens settings.local.json in editor) |

**3. Memory** — CLAUDE.md and any imported memory files.

| Per-row info | Per-row action |
|---|---|
| File path + line count | 📋 Copy contents |
| Last edited (mtime) | ✏ Open in editor |
| Marker if currently loaded | ♻ Re-inject (paste fresh contents as user message) |

**4. Turns** — last N turns of the conversation, collapsible.

| Per-row info | Per-row action |
|---|---|
| Turn # + role + 1-line summary | 🍴 Fork from here (creates new session/worktree at this point) |
| Token cost for this turn | ↩ Rewind here (truncate JSONL, restart claude with `--resume`) |
| Tools called in this turn | 📋 Copy turn |
| Timestamp | 🔍 Expand full content |

### Global toolbar (top of drawer)

| Icon | Action | Behavior |
|---|---|---|
| 💾 | Snapshot | Bundle current JSONL + `git diff <baseSha>` + pinned files → markdown in `<worktree>/.claude-vim/snapshots/<ts>/`. Toast: "Snapshot saved" |
| 🍴 | Fork session | Same as per-turn fork but pinned to "now" — creates new worktree from current branch HEAD, copies session JSONL via `claude --resume` |
| ↩ | Rewind | Modal: pick a turn from the list. Truncates JSONL after that turn, `claude --resume` |
| 📤 | Export | Markdown export to clipboard or file. User-friendly transcript suitable for sharing or pasting into a PR description |
| 🗜 | Compact | Modal: shows what /compact would summarize away. User can pin items to keep verbatim before triggering. Calls `/compact` in the PTY |
| ⚙ | Settings | Drawer settings popover (toggles below) |

### Toggles (in the ⚙ popover)

| Toggle | Default | Effect |
|---|---|---|
| Auto-snapshot before compact | ON | `PreCompact` hook triggers snapshot automatically before /compact runs |
| Re-inject pinned files after compact | ON | After compact, `UserPromptSubmit` hook prepends `<system-reminder>` containing pinned file contents |
| Show cache state inline in strip | ON | Cache hit % visible in collapsed strip |
| Show tool token weight | OFF | Estimate tokens spent on tool definitions (heavier compute) |
| Live tail JSONL (1s poll) | ON | Refresh on every PostToolUse hook + 1s tail to catch in-flight tool runs |
| Cost in strip | ON | Show `$1.42` next to tokens |

### Data plumbing

```
                                        ┌────────────────────┐
PostToolUse hook ──── HTTP ───────────► │ Rust hooks server  │
PreCompact hook  ──── HTTP ───────────► │ (existing M7.5)    │
Stop hook        ──── HTTP ───────────► └─────────┬──────────┘
                                                  │
                                                  │ tauri::emit
                                                  ▼
                            ┌──────────────────────────────────┐
                            │ frontend useContextSnapshot()    │
                            │  - reads JSONL on disk           │
                            │  - parses turns / tool results   │
                            │  - computes file list + tokens   │
                            └──────────────┬───────────────────┘
                                           │
                                           ▼
                              ┌────────────────────────┐
                              │ <ContextDrawer>        │
                              │  - tabs + actions      │
                              └────────────────────────┘
```

**Where the JSONL lives.** Claude Code writes session transcripts to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>` is
the worktree path with `/` replaced by `-`. The session id arrives in the first
hook payload after `claude` starts. We cache it per-session in Rust and emit it
to the frontend.

**Token math.** Each assistant turn in the JSONL has a `usage` object:
`{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`.
Sum of the three input fields = current context size at that turn. Latest turn
wins. Cost is per-model (Sonnet/Opus/Haiku rates hardcoded, override-able in
settings).

**File list extraction.** Walk JSONL; for every assistant message with a
`tool_use` block of type `Read | Edit | Write | MultiEdit | NotebookEdit`,
extract `input.file_path`. De-dup by path, last-access-wins ordering.
Estimated tokens per file = `lines / 4` (rough char-to-token heuristic), or
exact via re-tokenizing if we add `tiktoken-rs` later.

**Pin storage.** `<worktree>/.claude-vim/pins.json`:
```jsonc
{
  "version": 1,
  "pinned": [
    { "path": "src/components/SessionTabs.tsx", "addedAt": 1714060000 },
    { "path": "PLAN_SESSIONS.md", "addedAt": 1714060300 }
  ]
}
```

**Pin re-injection.** When the `UserPromptSubmit` hook fires, the hook script
checks `pins.json` and (if "Re-inject after compact" is on AND the last event
was `PreCompact`) prepends a system-reminder block with the pinned files'
contents. Implementation: extend the existing hook command to read pins +
contents and inject via stdout (Claude Code reads hook stdout as a
`<system-reminder>` for `UserPromptSubmit`).

## UI changes (component-level)

- **`src/components/ContextDrawer.tsx`** (new) — root component, manages tab
  state, expand/collapse, integrates with `useContextSnapshot`.
- **`src/components/ContextStrip.tsx`** (new) — the always-visible 1-line
  summary (tokens, cost, cache, global actions).
- **`src/components/ContextTabs/`** (new) — `FilesTab`, `ToolsTab`, `MemoryTab`,
  `TurnsTab`. Each is a list with action affordances per row.
- **`src/components/SnapshotModal.tsx`**, **`RewindModal.tsx`**,
  **`CompactPreviewModal.tsx`** (new) — overlays for the global actions.
- **`src/hooks/useContextSnapshot.ts`** (new file — note: `src/hooks/`
  doesn't exist yet, this introduces it) — Tauri command + event subscription
  that returns `{ tokens, cost, files, tools, memory, turns }` for the active
  session.
- **`src/App.tsx`** — wrap right pane in a vertical `react-resizable-panels`
  Group; bottom panel hosts `<ContextDrawer>`. Cmd+J binding via existing
  keymap. (Note: drawer spans editor + terminal width — full-width bottom,
  not just the right pane.)
- **`src/components/SessionTabs.tsx`** — reuse status dot logic; add a
  badge showing tokens used % when > 70%.

### Rust changes

- **`src-tauri/src/hooks.rs`** — add `post_tool_use`, `pre_compact` events
  to the endpoint match. Emit a new `session:context-tick` event so the
  frontend re-reads the JSONL.
- **`src-tauri/src/context.rs`** (new) — Tauri commands:
  - `read_session_jsonl(session_id) -> Vec<Turn>` (parsed)
  - `read_pins(worktree) -> PinFile`
  - `write_pins(worktree, pins) -> ()`
  - `write_snapshot(worktree, bundle) -> path`
- **`src-tauri/src/lib.rs`** — register the new commands and extend the
  hook script template to write `PostToolUse`, `PreCompact` entries.

## Milestones

| # | Goal | Done when |
|---|------|-----------|
| **M8.1** | Drawer shell + strip | Bottom drawer renders with tokens / cost / cache strip from latest JSONL turn. Cmd+J toggles. Resizable. Per-session collapse state persisted. |
| **M8.2** | Files tab + Open-in-editor action | Files tab lists every Read/Edit/Write target for active session. 👁 jumps to file in editor. ↺ refresh re-reads JSONL on demand. |
| **M8.3** | Pins | 📌 Pin / unpin per file. `pins.json` per worktree. Pinned files float to top. Pin marker in tree-view too (left pane). |
| **M8.4** | PostToolUse / PreCompact / Stop hooks → live updates | Drawer auto-refreshes within 1s of any tool call. Pre-compact fires `PreCompact` event in frontend (modal hook for M8.6). |
| **M8.5** | Snapshot global action | 💾 writes markdown bundle to `<worktree>/.claude-vim/snapshots/<ts>/`. Bundle = transcript.md + diff.patch + pinned-files/*. Toast with path. |
| **M8.6** | Compact preview modal | 🗜 opens modal showing JSONL turn list with checkboxes for "keep verbatim". Triggers `/compact` in the PTY after confirmation. Auto-snapshots first if toggle is on. |
| **M8.7** | Pin re-injection | After `/compact`, `UserPromptSubmit` hook prepends pinned file contents as `<system-reminder>`. Verified by triggering compact and watching the next turn re-load the pinned file. |
| **M8.8** | Tools tab | Lists active MCP servers + built-in tool names. ⏸ disables an MCP server (writes to settings.local.json + toast: "restart claude to apply"). |
| **M8.9** | Turns tab + Fork / Rewind | Last N turns visible. 🍴 fork creates new session/worktree at that turn (copies JSONL, runs `claude --resume`). ↩ rewind truncates JSONL + restarts. |
| **M8.10** | Memory tab + Re-inject | CLAUDE.md preview + ✏ open + ♻ re-inject (paste fresh into next user prompt). |
| **M8.11** | Settings popover + remaining toggles | All toggles wired and persisted to per-worktree `.claude-vim/settings.json`. |
| **M8.12** | Export markdown | 📤 produces clean transcript suitable for sharing — strips ANSI, redacts API keys (regex-based), copies to clipboard or saves to file. |

Estimate: 10–14 evenings end-to-end. M8.1–M8.4 are the foundation (drawer +
data + live updates). M8.5–M8.7 deliver the headline win (snapshot before
compact + pin re-injection — directly addresses the auto-compact data loss
pain). M8.8–M8.12 are the long tail.

## Risks / unknowns

- **Claude Code JSONL format stability.** The schema isn't a public contract.
  Mitigation: parse defensively, log unknown shapes, version-detect from the
  presence of fields. Pin a tested Claude Code version range in the README.
- **Hook stdout for re-injection.** `UserPromptSubmit` injecting via stdout
  is documented but the exact wrapping behavior may differ between Claude
  Code versions. Mitigation: test on the latest stable; fall back to
  emitting a regular user message line if stdout injection breaks.
- **Compact race.** If the user triggers `/compact` directly in the PTY
  (bypassing the modal), `PreCompact` still fires the snapshot — but the
  pin re-injection only kicks in on the *next* `UserPromptSubmit`. If the
  user's next prompt is "ok continue" with no useful context for re-injection
  to anchor to, the pinned files still get loaded but feel out-of-place.
  Acceptable for v1.
- **Token estimates for files.** `lines / 4` is rough. Off by 30–50% for
  code-heavy files. Mitigation: ship the heuristic; add `tiktoken-rs` as an
  opt-in for accurate counts (heavier dep, slower).
- **MCP disable requires restart.** Claude Code reads MCP config at start
  only. Disabling a server in the drawer can't take effect mid-session.
  Mitigation: clear toast saying "restart claude to apply" + a one-click
  "restart claude" button (we already restart PTY on folder change).
- **Snapshot bloat.** Snapshots can be 100KB+ each. Mitigation: cap to last
  N snapshots per session, gzip after 7 days, surface size in settings.
- **Pins can drift.** A pinned file deleted on disk → re-injection injects
  empty content. Mitigation: validate paths on each re-injection; auto-unpin
  with a toast if missing.
- **Cost rates hardcoded.** Anthropic price changes break $ display.
  Mitigation: pull rates from a small JSON shipped with the app, surface
  "Last updated" date in settings, allow manual override.

## Open issues for later

- Diff view of context state across two snapshots ("what changed since 2pm?")
- "Why is this in context?" — trace back to the turn that loaded each file
- Pin a *line range* not just a whole file
- Auto-pin: rules like "always pin any file matching `**/PLAN*.md`"
- Cross-session pinning: "pin this file in every new session of this worktree"
- Inline /compact preview that shows token savings before you confirm
- Drag-and-drop a file from the tree → pin
- Token spend chart over time (per session, per day)
- Hook for `SubagentStop` if Claude Code adds it — would let us track
  subagent runs in the Tools tab
- Web-based "share session" link (out of scope for v1; ephemeral by design)
