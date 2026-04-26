# Auto-research plan

Run multiple sessions in parallel as branched worktrees, each exploring a
different approach to the same problem. Compare them side-by-side. Merge the
winner as a whole branch, throw the losers away. The branching half exists
already (M7.2 worktrees + branches per session); this is the workflow half.

The unit of work is a **branch**, not a file. A session figures something out
(or doesn't); you merge the whole branch (or kill it). File- and hunk-level
cherry-picking exist in IDEs already and aren't what auto-research wants —
if a session's exploration is only partially trustworthy, the right move is
to spawn a tighter-scoped session, not to pluck two files out of a sprawling
diff.

This solves the wishlist's #1 ask: branching with merge-back. It also makes
parallel experimentation a real workflow — three sessions try three approaches,
you scan diffs, merge the winner, kill the losers. Today, sessions branch and
die. After this, sessions branch, get compared, and the survivor merges.

The merge/discard plumbing is only the *back half*. The front half is
**spawning N experiments from one prompt** so you have something to compare
and merge. Without spawn, the merge UI is a nice tool you'd reach for twice
a week. With spawn, it's the closing step of an end-to-end auto-research
loop you reach for whenever you'd otherwise type "claude, try this" once
and pray. See "Auto-research workflow" below.

## Decisions locked in

| Question | Choice |
|---|---|
| Merge primitive | **`git merge --no-ff` of the whole branch** (or `git rebase` then merge for linear history). No file-level patch surgery. |
| User-facing verbs | **Merge** (bring branch into target) and **Discard** (delete worktree + branch). Reserve "Promote findings" for the no-code summary action. |
| Granularity | **Branch-level only.** No file checkboxes, no hunk pickers. The diff view is for *review*, not for selection. |
| Apply mechanism | **`git -C <target> merge <source-branch>`** after auto-committing source. Conflicts open in the editor with native `<<<<<<<` markers. |
| Source must be… | **`idle` status** (M7.5). Merge button disabled if source is `working` / `blocked` / `error`. |
| Target default | **`main` session** (the original folder, on HEAD's branch). Dropdown for any other open session. |
| Target must be clean | **Refuse to merge into a dirty target.** Surface the modified files and ask the user to commit/stash in that session first. No invisible stashing — the silent-stash horror story isn't worth the convenience. |
| Drift handling | **"Rebase onto target" button** before merge. Default warns if source is >50 commits behind target HEAD. |
| Conflicts | **Native git conflicts.** When `git merge` reports conflicts, surface the conflicted files in the modal; clicking one opens the file in the editor with the real merge markers. Resolve, save, click "Continue merge." |
| Commit in source | **Auto-commit pending changes** before merge, with summary message from transcript |
| Merge commit message | **Auto-drafted from transcript** (subject + body), always editable. Used as the merge commit message. |
| Source after merge | **Stays alive by default** so you can keep iterating. Optional checkbox: "Discard source after merge" → runs M7.2 cleanup |
| UI shape | **Full-screen modal takeover.** Editor area swaps to a diff + commit-message view; tabs and bottom drawer stay accessible |
| Trigger | Right-click session tab → "Merge…" / "Discard" / "Compare with…" / "Promote findings →" + global "Compare sessions" toolbar action |
| Open as PR | **First-class action.** "Merge & PR" pushes the source branch and runs `gh pr create` with the auto-drafted message as body, instead of merging locally. For teams, this *is* the merge step. |
| "Promote findings" (no code) | **Yes, separate action.** Generates session summary markdown → drops into target session's pinned files via PLAN_CONTEXT.md `pins.json` |
| Environment duplication | **Per-worktree port allocation** (M9.13). Each worktree gets a stable port offset to dodge dev-server collisions across parallel sessions. Without this the auto-research workflow falls over before merge is relevant. |
| Spawn surface | **Toolbar dialog** (user-driven, v1) + **MCP tool** (agent-driven, v1). Both fan out N sessions from one prompt with optional per-variant hints. |
| Variation source | **Hints + temperature.** If user gives N distinct hints, each session gets a different system-reminder. If hints blank, all N get the same prompt and rely on Claude's nondeterminism. |
| Experiment grouping | Sessions spawned together share an `experiment_id` and appear as a single row in a dashboard view, with status / tokens / diff stats / score. |
| Auto-eval | **Optional shell command per experiment group.** Runs in each idle session's worktree, last stdout line read as numeric score. Powers "Merge winner" and the v2 iterate loop. |
| Autonomous loop | **v2.** Orchestrator session uses MCP tool to spawn → wait → eval → keep best → repeat. Karpathy-style autoresearch over code, scoped to one user-set metric. |

## Why branch-level not file-level

The dominant pattern in worktree + AI-agent tooling (Conductor, parallel-code,
Crystal, Code Conductor, Claude Code's own subagent isolation) is:

> **one task → one branch → one worktree → one agent → one merge or one discard.**

The whole branch is the unit. Reasons:

1. **Auto-research is "did this approach work?"**, not "which lines of this
   approach should I keep?" Sessions either figured something out or didn't.
2. **`git merge` already handles conflicts well**, with native markers and a
   recovery flow every dev knows. Inventing a parallel "synthesize merge
   markers from `git apply --check`" UI duplicates work git does for free.
3. **File-cherry-pick rewards over-trusting one session's exploration.** If
   you only want some files, you probably shouldn't trust the rest of that
   session's reasoning either — better to spawn another session with tighter
   scope than to pluck two files out of a sprawling diff.
4. **PRs are the team-collaboration unit anyway.** "Merge & PR" maps 1:1 onto
   how teams already integrate work; file-cherry-pick doesn't.

For the rare case someone genuinely wants partial picks, the editor + plain
`git checkout source-branch -- path/to/file` works fine and isn't worth a
custom UI. We can revisit if real demand shows up.

## Auto-research workflow

The reference patterns from the broader AI-coding ecosystem:

- **Crystal / best-of-N (the common case).** User types one prompt, N
  sessions start in parallel worktrees, each tries a different approach,
  user picks the winner from a comparison view. Used heavily for UI work
  ("show me 3 versions of this layout") and for "I'm stuck, brute force
  it" moments. This is the v1 we're building.
- **Karpathy's autoresearch (the autonomous case).** An agent iterates
  ~100 experiments overnight against a fixed metric (val_bpb in his
  case), keeping wins and discarding losses. ~12 experiments/hour. This
  is the loop version of best-of-N — the metric, not the user, picks the
  winner. We support this in v2 via auto-eval + the MCP spawn tool.
- **Orchestrator / split-and-merge.** Parent agent decomposes a goal
  into N *different* subtasks (not N attempts at the same thing), fans
  out, and reassembles. Different shape; deferred — see open issues.

End-to-end loop in claude-vim:

```
[Spawn experiments]  ──►  N worktrees + sessions, each with a hint
        │
        ▼
[Experiment dashboard]  ──►  watch status / tokens / diff stats / score
        │
        ▼
[Compare]  ──►  side-by-side diffs (M9.11 modal seeded with all N)
        │
        ▼
[Merge winner]  ──►  branch-level merge of best session into target
[Discard losers]  ──►  worktree remove + branch delete for the rest
```

For autonomous loops, replace [Compare] / manual selection with:

```
[Auto-eval runs after each idle]  ──►  numeric score per session
        │
        ▼
[Spawn-and-iterate]  ──►  next batch branches from current best, repeat
```

### Spawn from the toolbar (user-driven)

Toolbar action / palette: **"Spawn experiments"** opens a dialog:

```
┌────────────────────────────────────────────────────────────────────────┐
│  Spawn experiments                                  [Cancel]  [Spawn]  │
├────────────────────────────────────────────────────────────────────────┤
│  Prompt                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │ Refactor App.tsx state management to be cleaner.             │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  How many experiments?    [3 ▾]                                        │
│                                                                         │
│  Variant hints (one per experiment, optional)                          │
│   1. ┌────────────────────────────────────────────────────────┐        │
│      │ Try useReducer.                                         │        │
│      └────────────────────────────────────────────────────────┘        │
│   2. ┌────────────────────────────────────────────────────────┐        │
│      │ Try Zustand.                                            │        │
│      └────────────────────────────────────────────────────────┘        │
│   3. ┌────────────────────────────────────────────────────────┐        │
│      │ Try plain Context + custom hooks.                       │        │
│      └────────────────────────────────────────────────────────┘        │
│                                                                         │
│  Branch from: main ▾                                                   │
│  ☐ Auto-eval with: ./scripts/score.sh                                  │
└────────────────────────────────────────────────────────────────────────┘
```

On Spawn:
1. Create N worktrees + branches off the chosen base (M7.2 already does this)
2. For each session, prepend its hint to the prompt as a `<system-reminder>`
3. Send the prompt to each session's PTY in parallel
4. Tag the N sessions with a shared `experiment_id`
5. Open the experiment dashboard for the new group

If hints are blank, all N sessions get the identical prompt and the
variation comes from Claude's nondeterminism — that's still useful for
"brute force three attempts and pick the cleanest."

### Spawn from inside a session (agent-driven, MCP tool)

For autonomous loops, the main session's Claude needs to spawn experiments
itself. claude-vim ships a built-in MCP server, auto-registered with each
session, exposing:

- `spawn_experiment(prompt, hints[], base?) → [session_id]`
- `wait_for_experiments(session_ids[], timeout_s?) → [{id, status, diff_stats, score?}]`
- `get_experiment_diff(session_id) → string`
- `merge_experiment(session_id, message?) → { sha }`
- `discard_experiment(session_id) → void`

Auto-registration means the agent can call these out of the box — no setup
the user has to wire up. This is what enables Karpathy-style overnight
loops: an orchestrator session calls `spawn_experiment` 5 times, awaits,
inspects diffs, scores them, merges the winner, repeats.

Fallback for users who'd rather avoid MCP: a `claude-vim spawn` CLI that
the agent can invoke via Bash with the same arguments.

Safety: the MCP tool requires the calling session to be the user's "main"
session (or any session the user has opted-in via setting). Otherwise,
spawned-by-agent sessions could spawn-by-agent recursively and burn tokens
unbounded. v1: hard cap at depth 1 + N ≤ 5 per call + total ≤ 20 active
agent-spawned sessions. Configurable.

### Experiment dashboard

When you spawn a group of N sessions (toolbar or MCP), they share an
`experiment_id` and appear as one row in a new dashboard view:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Experiment: refactor App.tsx (3 variants)              [Compare]  [Close] │
├──────┬──────────────────┬─────────┬─────────┬──────────┬─────────┬────────┤
│  #   │ Hint             │ Status  │ Tokens  │ Files Δ  │ Score   │ Action │
├──────┼──────────────────┼─────────┼─────────┼──────────┼─────────┼────────┤
│  1   │ useReducer       │ idle 🟢 │ 12.3k   │ +42 -18  │ 8.5/10  │ Merge  │
│  2   │ Zustand          │ idle 🟢 │ 18.1k   │ +89 -45  │ 7.2/10  │ Merge  │
│  3   │ Context + hooks  │ working │ 8.7k    │ —        │ —       │ —      │
└──────┴──────────────────┴─────────┴─────────┴──────────┴─────────┴────────┘
                                                  [Merge winner]  [Discard losers]
```

Score column populated by the optional auto-eval command. **Merge winner**
merges the highest-scored idle session and discards the rest. **Discard
losers** lets you merge manually but kills the rest in one click. **Compare**
opens the existing compare-only modal (M9.11) seeded with all N sessions.

### Auto-eval (optional, Karpathy-style)

The user attaches a shell command at spawn time (e.g., `./scripts/score.sh`,
`bun test --json`, a custom benchmark). When a session in the group goes
idle (M7.5 status):

1. Run the eval command in that session's worktree
2. Capture stdout's last line as the score (parse as float; non-numeric → null)
3. Display in the dashboard
4. If MCP, the agent reads scores via `wait_for_experiments` return value

This is the closure step that turns claude-vim from a Crystal-style picker
into a Karpathy-style autoresearch host.

### Spawn-and-iterate (v2 autonomous loop)

In the spawn dialog, an advanced option:

- **Iterate:** keep spawning batches of N from the current best until the
  score plateaus (no improvement for K rounds) or N iterations elapse
- Each iteration's "best" becomes the base branch for the next batch
- The orchestrator session (the one that initiated, or main) gets a
  running log appended as `<system-reminder>`s: attempt N, score, decision

This is full Karpathy autoresearch over a code task: you go to bed,
claude-vim runs ~100 experiments, in the morning the highest-scored branch
is sitting in the dashboard ready to merge.

## Architecture

### Merge modal layout

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Merge session 2 → main      [Cancel]  [Discard]  [Merge & PR]  [Merge]        │
├────────────────────────────────────────────────────────────────────────────────┤
│  Source: session 2 (claude-vim/01HX…)  •  idle 🟢  •  baseSha 7a3f2…           │
│  Target: main (branch: feature/foo)    •  idle 🟢  •  HEAD 8b1d4…    [▾]       │
│  Drift: source is 3 commits behind target              [Rebase onto target]    │
├────────────────────────────────────────────────────────────────────────────────┤
│  Files changed (4)                                                              │
│   src/App.tsx          +42 -18                                                  │
│   src/Editor.tsx       +12  -3                                                  │
│   PLAN_CONTEXT.md      +5   -0                                                  │
│   src/types.ts         +8   -2                                                  │
├────────────────────────────────────────────────────────────────────────────────┤
│   diff view (unified ▾ / side-by-side)                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐     │
│  │ - const x = 1                                                        │     │
│  │ + const x = 2                                                        │     │
│  │   ...                                                                │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
├────────────────────────────────────────────────────────────────────────────────┤
│  Merge commit message  ✏                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐     │
│  │ Merge session 2: refactor App.tsx state model                        │     │
│  │                                                                      │     │
│  │ Session findings:                                                    │     │
│  │ - Replaced useState pair with useReducer for editor flags           │     │
│  │ - Editor.tsx now subscribes to a single store                       │     │
│  │                                                                      │     │
│  │ ☐ Include full transcript in commit body                            │     │
│  │ ☐ Discard source session after merge                                │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────────┘
```

When triggered: editor + tree dim and slide; modal takes over center. Tab bar
and bottom drawer (PLAN_CONTEXT.md) remain interactive — you can still chat
with the source session if you need it to explain or fix something mid-review.

### Merge pipeline

```
[Merge button] ─►
  1. Validate source status == idle           (else: disable + tooltip)
  2. Validate target is clean                  (else: surface dirty files, abort)
  3. Auto-commit source pending changes        (git -C <src> add -A && commit -m "<auto>")
  4. (optional) Rebase source onto target      (if user clicked Rebase first)
  5. Run merge:  git -C <tgt> merge --no-ff <source-branch> -m "<msg>"
       ├─ clean:    proceed
       └─ conflict: surface conflicted files in modal, halt
  6. (on conflict) User resolves in editor → "Continue merge" runs
       git -C <tgt> add <files> && git -C <tgt> commit --no-edit
  7. Optional: M7.2 cleanup on source (if "Discard source" checked)
  8. Emit:     session:merged event → toast → close modal

[Merge & PR button] ─► steps 1–4 same, then:
  5a. git -C <src> push -u origin <source-branch>
  5b. gh pr create --base <target-branch> --title <subject> --body <body>
  (no merge in target; that happens via PR review on the remote)

[Discard button] ─►
  1. Confirm dialog ("Delete worktree and branch claude-vim/<id>? Irreversible.")
  2. git worktree remove --force <src-path>
  3. git branch -D <source-branch>
  4. Emit session:discarded → close session tab
```

Failure during merge: `git merge --abort` restores target to pre-merge state,
surface error, leave source untouched. No stashing on target so no stash to
restore.

### Source-session auto-commit message

Generated from the source session's JSONL transcript at
`~/.claude/projects/<slug>/<sid>.jsonl` (same source as PLAN_CONTEXT.md):

- **Subject** (≤72 chars): the first user prompt of the session, truncated.
  E.g. user said "refactor App.tsx to use useReducer" → subject becomes
  `wip: refactor App.tsx to use useReducer`.
- **Body**: list of files touched + line counts + the last assistant turn's
  one-line summary (extract first sentence).

This is just the *source* commit. The user-facing message is the merge commit
(below), which uses the same template applied to the full session.

### Merge commit message (the one users care about)

Auto-drafted from the session transcript using a deterministic template, not
an LLM call (no extra cost, no latency):

```
Merge session <name>: <subject>

Session findings:
<bulleted list of distinct file changes, derived from
 (a) git diff stats per file
 (b) the last assistant message that mentioned each file's path>

Merged from claude-vim/<id> @ <short-sha>.
```

If user toggles "Include full transcript in commit body": appends a `---`
separator and a markdown rendering of the user/assistant turns. Useful for
PRs where reviewers want to see the prompt that produced the change.

### Conflict resolution

Native `git merge`. When step 5 reports conflicts:

- Modal stays open, file list shows conflicted files with 🟥 markers
- Clicking opens the file in the target's worktree with real `<<<<<<<` markers
- User edits, saves, clicks **Continue merge** → modal stages and finishes
- **Abort merge** → `git merge --abort`, modal restored to pre-merge state

No synthesized markers, no per-file dry-runs, no parallel conflict-detection
pipeline. Git already does this and the resolution flow is one every dev knows.

### Compare-only mode (no merge)

Same modal, no Merge / Discard buttons. Just diff view. Used when:
- Three sessions running in parallel, you want to look at all of them
- Reviewing what a session did before deciding whether to merge or discard
- Diff'ing two non-main sessions against each other

Trigger: global "Compare sessions" toolbar button → modal with two source
dropdowns and no commit-message panel.

### Promote findings (no code)

Separate action in the right-click session tab menu: "Promote findings → main."
Generates a session summary markdown:

```
# Findings from session <name>

Branch: claude-vim/<id>
Started: <ts>
Ended: <ts>

## Conversation summary
<first user prompt>
<last assistant message, full>

## Files explored
- src/App.tsx
- src-tauri/src/lib.rs
- ...

## Key tool outputs
<grep / find / test results worth keeping>
```

Writes to `<target-worktree>/.claude-vim/promoted-findings/<source-id>.md`.
Then leverages PLAN_CONTEXT.md infra: appends the file path to target's
`pins.json` so the next time the user prompts the target session, the findings
are auto-injected as `<system-reminder>`. No code touches the target's
working tree. Useful for "this session figured out the data model, now I want
the main session to know about it without copying any code."

### Per-worktree port allocation

The Trigger.dev pain point: parallel worktrees collide on dev-server ports
(3000, 3030, etc.), shared databases, etc. Without this, parallel sessions
silently fight over ports and the auto-research workflow falls over before
merge is even relevant.

Mitigation:

- Each worktree gets a stable per-session port offset (e.g., session 1 → +0,
  session 2 → +10, session 3 → +20)
- Injected as env vars (`PORT`, `VITE_PORT`, etc.) when the session's PTY
  spawns
- `.claude-vim/ports.json` per worktree records the assignment so scripts
  and tests can read it

Not strictly part of the merge flow, but the thing that bites first when you
actually try to run 3+ parallel sessions for auto-research.

## UI changes (component-level)

- **`src/components/MergeModal.tsx`** (new) — root component, manages source/target
  selection, file list, diff pane, message editor, merge action.
- **`src/components/DiffView.tsx`** (new) — unified + side-by-side diff
  rendering. Reuses CodeMirror 6 for syntax-highlighted diff text. Probably
  pulls in `@codemirror/merge` for side-by-side.
- **`src/components/CommitMessageEditor.tsx`** (new) — small editable textarea
  with subject/body split, character counter on subject.
- **`src/components/ConflictBanner.tsx`** (new) — inline modal banner when a
  merge halts on conflicts; "Continue merge" / "Abort merge" buttons; list of
  conflicted files with click-to-open.
- **`src/components/SessionTabs.tsx`** — add right-click context menu items:
  "Merge…", "Merge & PR…", "Compare with…", "Promote findings →", "Discard".
- **`src/components/SpawnDialog.tsx`** (new) — prompt + N + per-variant
  hints + base branch + optional auto-eval command. Submits to
  `spawn_experiments` Tauri command.
- **`src/components/ExperimentDashboard.tsx`** (new) — group view for
  sessions sharing an `experiment_id`. Status / tokens / diff stats /
  score columns; "Merge winner" / "Discard losers" / "Compare" actions.
- **`src/hooks/useMerge.ts`** (new) — orchestrates the pipeline, surfaces
  status (validating / committing / merging / conflict / done / error).
- **`src/hooks/useExperiment.ts`** (new) — subscribes to status changes for
  all sessions in an experiment group; runs auto-eval on idle.
- **`src/App.tsx`** — render `MergeModal` / `SpawnDialog` /
  `ExperimentDashboard` when active; dim main UI behind modals.

### Rust changes

- **`src-tauri/src/merge.rs`** (new) — Tauri commands:
  - `merge_session(source_id, target_id, message, discard_source) -> Result<sha, MergeError>`
  - `merge_continue(target_id) -> Result<sha, MergeError>`
  - `merge_abort(target_id) -> Result<()>`
  - `merge_open_pr(source_id, target_id, message) -> Result<pr_url, Error>`
  - `compare_sessions(a_id, b_id) -> Vec<FileChange>`
  - `discard_session(source_id) -> Result<()>`
  - `auto_commit_source(source_id) -> sha`
  - `generate_merge_message(source_id, target_id) -> { subject, body }`
  - `rebase_session_onto(source_id, target_id) -> Result<()>`
- **`src-tauri/src/git.rs`** — extend with: `merge_branch`, `merge_continue`,
  `merge_abort`, `commit_with_message`, `branch_delete`, `worktree_remove`,
  `rebase_onto`, `push_branch`. Most are thin wrappers around `git2` or
  shelling out to `git`.
- **`src-tauri/src/ports.rs`** (new) — assign and persist per-session port
  offsets; expose to PTY env on spawn.
- **`src-tauri/src/experiment.rs`** (new) — Tauri commands:
  - `spawn_experiments(prompt, hints[], base, auto_eval?, iterate?) -> { experiment_id, session_ids[] }`
  - `list_experiments() -> Vec<Experiment>`
  - `experiment_status(experiment_id) -> Vec<ExperimentMember>`
  - `run_auto_eval(session_id, command) -> { score?, output }`
  - `merge_winner(experiment_id) -> { sha, discarded: [session_id] }`
  - `discard_losers(experiment_id, keep: session_id) -> void`
- **`src-tauri/src/mcp.rs`** (new) — embedded MCP server bound to a Unix
  socket per claude-vim instance; auto-injected into each session's Claude
  Code config via `~/.claude/settings.json` patch on session create.
  Exposes the agent-facing tool surface listed in "Spawn from inside a
  session" above. Routes calls back to `experiment.rs` Tauri commands with
  caller-session validation + safety caps.

### Reuse from existing infrastructure

| What we reuse | From |
|---|---|
| Worktree paths, baseSha, branch names | M7.2 session data model |
| `git status --porcelain` to list changed files | M7.4 |
| Status hooks (idle/working/blocked) for source-readiness gate | M7.5 |
| Line-level diff parsing | M7.6 (planned) |
| JSONL transcript reader for commit-message generation | PLAN_CONTEXT.md M8.4 |
| Pin mechanism for "Promote findings" | PLAN_CONTEXT.md M8.3 |
| Bottom-drawer snapshot bundles as alternate input format | PLAN_CONTEXT.md M8.5 |

This plan is small precisely because so much of the machinery already exists,
and because we're using `git merge` instead of inventing one.

## Milestones

| # | Goal | Done when |
|---|------|-----------|
| **M9.1** | Merge modal shell + file list | Right-click tab → "Merge…" opens modal. Source + target shown. Changed files listed (read-only, no checkboxes). Cancel returns to main UI. |
| **M9.2** | Unified diff view per file | Click a file → unified diff renders in modal's right pane. Syntax highlighting via CodeMirror. |
| **M9.3** | Auto-commit source + branch-level merge into target | Pipeline steps 1–5 wired with `git merge --no-ff`. Default commit message used. Toast on success. `git merge --abort` on failure. |
| **M9.4** | Auto-generated merge commit message | Subject + body drafted from JSONL + diff stats. Editable in the message editor. "Include transcript" checkbox appends full markdown. |
| **M9.5** | Native conflict resolution | When merge reports conflicts, surface them in the modal; "Open in editor" opens with real `<<<<<<<` markers; "Continue merge" / "Abort merge" buttons. |
| **M9.6** | Discard experiment | "Discard" button on tab and modal: `git worktree remove --force` + `git branch -D` after confirm. Closes session. |
| **M9.7** | Rebase source onto target | "Rebase onto target" button in modal. Drift indicator shows commits behind. On rebase conflict, fall back to native conflict flow. |
| **M9.8** | Merge & PR | "Merge & PR" button: pushes source branch and runs `gh pr create` with the auto-drafted message as body. Opens PR URL in browser. |
| **M9.9** | Target dropdown | Switch target away from main → any other open session. baseSha math recomputed. |
| **M9.10** | Side-by-side diff toggle | Switch unified ↔ side-by-side. Persist preference per-session in localStorage. |
| **M9.11** | Compare-only mode | Global "Compare sessions" toolbar opens the modal with two source dropdowns and no Merge button. |
| **M9.12** | Promote findings (no code) | Right-click → "Promote findings → main" generates summary markdown, writes to target worktree, appends to target `pins.json`. Toast: "Findings pinned to main session." |
| **M9.13** | Per-worktree port allocation | Each session gets a stable port offset; injected as `PORT` / `VITE_PORT` env vars when PTY spawns; written to `.claude-vim/ports.json` for scripts to read. |
| **M9.14** | Discard-source-after-merge checkbox | If checked, runs M9.6 cleanup on merge success. |
| **M9.15** | Spawn experiments dialog (toolbar) | Toolbar / palette action opens dialog with prompt + N + per-variant hints + base branch. Creates N worktrees, sends prompts to each PTY in parallel, tags with shared `experiment_id`. |
| **M9.16** | Experiment dashboard | New view shows experiment groups as rows: variants, status, tokens, diff stats. "Merge winner" / "Discard losers" / "Compare" actions wired to existing M9.3 / M9.6 / M9.11 plumbing. |
| **M9.17** | MCP spawn tool (agent-driven) | Embedded MCP server auto-registered with each session. Exposes `spawn_experiment` / `wait_for_experiments` / `get_experiment_diff` / `merge_experiment` / `discard_experiment`. Safety caps: depth 1, N ≤ 5 per call, ≤ 20 active agent-spawned sessions. |
| **M9.18** | Auto-eval per experiment | Optional shell command attached at spawn; runs in each session's worktree on idle; last stdout line parsed as numeric score; surfaced in dashboard. |
| **M9.19** | Spawn-and-iterate (v2) | Advanced toggle in spawn dialog: keep spawning batches of N from current best until plateau (no improvement K rounds) or N iterations. Orchestrator session gets running log as `<system-reminder>` updates. |

Estimate: 11–14 evenings end-to-end.

The slices:

- **Core merge loop (M9.1–M9.6, ~4 evenings):** review diff → merge or
  discard → native conflict handling. The minimum viable workflow.
- **Merge polish (M9.7–M9.8, ~1.5 evenings):** drift handling + PR path.
- **Comparison + routing (M9.9–M9.11, ~1.5 evenings):** target dropdown,
  side-by-side, compare-only.
- **Findings + plumbing (M9.12–M9.14, ~1.5 evenings):** PLAN_CONTEXT pin,
  port allocation, discard-after-merge.
- **Auto-research front half (M9.15–M9.16, ~2 evenings):** spawn dialog +
  experiment dashboard. After this, claude-vim is a Crystal-equivalent.
- **Agent-driven loop (M9.17–M9.19, ~3 evenings):** MCP tool, auto-eval,
  spawn-and-iterate. After this, claude-vim is a Karpathy-style autoresearch
  host that runs overnight and presents the winner in the morning.

Ship M9.1–M9.16 first; M9.17–M9.19 are a second wave once the manual loop
proves out the UX.

## Risks / unknowns

- **Conflicts will be the thing.** Most painful UX in any merge tool. Our
  bet: let `git merge` do its job, surface conflicted files, open them in
  the editor with native markers, give a "Continue merge" button. No clever
  parallel conflict UI. If users want a real merge tool, they have one.
- **Target with uncommitted work.** Refusing to merge into a dirty target
  is the conservative call. Mitigation: surface the dirty files in the modal
  with a "Jump to target session" button so the user can commit there first.
  No invisible stashing — the silent-stash horror story isn't worth the
  convenience.
- **Source mid-edit.** Auto-commit step captures whatever is on disk —
  could be a half-finished thought. Mitigation: only allow merge when
  source status == idle (M7.5 already gives us this).
- **Branch divergence.** If main has moved a lot since the source branched,
  the merge can be ugly. Mitigation v1: warn if source's baseSha is >50
  commits behind target HEAD; offer "Rebase onto target" inline (M9.7).
- **Two sessions edited the same file.** Last-merger-wins semantics. v1:
  the second merge will conflict, surface that, let user reconcile in
  editor. v2: a "merge sessions" three-way action.
- **Auto-message quality.** Templated, not LLM-generated, so messages can
  be terse or repetitive. Mitigation: always editable; quality bar is "good
  enough that the user just hits Enter 80% of the time."
- **Worktree-local config interplay.** Target worktree's hooks fire during
  merge (e.g., a pre-commit hook could fail). Mitigation: respect hooks by
  default; offer a "skip hooks (--no-verify)" toggle for power users.
- **Port allocation collisions with hardcoded ports.** If the user has a
  hardcoded port in `vite.config.ts`, our env-var override won't reach it.
  Mitigation v1: document the env-var contract; v2: detect common configs
  and offer to patch them.
- **Disk bloat from many worktrees.** Trigger.dev reported 9.82 GB for two
  worktrees of a 2 GB codebase. Mitigation v1: surface total worktree disk
  usage in the session tab list; v2: shared `node_modules` via symlink (with
  caveats around peer-dep mismatches).
- **`gh` not installed / not authed.** Merge & PR depends on it. Mitigation:
  detect on first use, surface a one-time setup prompt with install + auth
  instructions; fall back to plain Merge if user opts out.
- **Token burn from agent-driven spawn (M9.17).** Without caps, an
  orchestrator that decides "let me try 50 more experiments" can spend a
  rent payment overnight. Mitigation: hard depth/N caps in MCP layer
  (depth 1, N ≤ 5/call, ≤ 20 active), cumulative-cost ceiling per
  `experiment_id`, dashboard surfaces running spend, Stop-All button.
- **Eval gaming.** A score function the agent can read + the ability to
  edit `score.sh` = Goodhart's Law. Mitigation: by default the auto-eval
  command path is read-only-from-the-experiment's-perspective (it lives
  in the *target* worktree, not the source); document the trap; offer a
  "freeze eval script" toggle.
- **Variant collapse.** N sessions with the same prompt can produce N
  near-identical solutions if Claude's nondeterminism is low on that task.
  Mitigation: encourage hints in the spawn dialog; if all N diffs are >90%
  identical at idle, surface a banner suggesting more diverse hints.
- **MCP injection into existing user config.** Auto-registering the spawn
  MCP server means writing to `~/.claude/settings.json` (or session-local
  equivalent). Mitigation: scope the registration to the session-local
  config under `.claude-vim/` if Claude Code supports it; otherwise patch
  global with a clearly-marked block we own and can cleanly remove.

## Open issues for later

- File-level cherry-pick as a power-user escape hatch ("Take this one file
  from session 2 into main"). Deferred until users actually ask.
- Hunk-level selection — same; IDEs already do this well.
- Three-way merge UI for the "two sessions edited same file" case
- "Merge queue" — line up multiple source sessions, batch merge in order
  (with auto-rebase between)
- Branch graph visualization across all sessions in the workspace
- Annotate diff hunks with "Claude said this about this hunk" — pull the
  reasoning from the JSONL turn that produced the edit
- "Suggest target" — heuristic: if source touched files that overlap with
  another session's changes, suggest that session as target instead of main
- Merge-and-keep-discussing — keep the source session's PTY alive after
  merge so the user can ask follow-ups about what was merged
- Hook for "post-merge" so users can wire up custom actions (test runs,
  Slack notify, etc.)
- Cross-worktree `git mv` detection — preserved by `git merge` already, but
  worth surfacing in the diff view as renames not delete-then-add
- Shared dev-server (one Vite, multiple worktree mounts) as an alternative
  to per-worktree port allocation, for codebases where dep duplication is
  the bigger pain than port collisions
- **Orchestrator / split-and-merge** auto-research (different from best-of-N):
  parent agent decomposes a goal into N *different* subtasks, fans out, and
  reassembles. Different shape than M9.15–M9.19 — those are N attempts at
  the same task. Orchestrator pattern needs a task-DAG + cross-session
  artifact passing.
- **Cross-session forum** (Anthropic AAR-style): a shared scratchpad where
  parallel experiments post findings and other experiments can read them.
  Useful when experiments aren't fully independent.
- **Score function library** (Karpathy-style metric presets): test-pass-rate,
  bundle-size delta, lighthouse score, custom diff-quality LLM judge. Saves
  users from writing `score.sh` from scratch.
- **Token / cost budgets per experiment group**: hard cap on total spend so
  an overnight iterate loop can't burn unbounded credits. Surface remaining
  budget in the dashboard.
- **Resume an experiment group**: re-open closed dashboard for an old
  group, see history, optionally spawn a new batch from any past winner.
