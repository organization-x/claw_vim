# Merge-back plan

Bring a session's work into another session (usually `main`) without leaving the
app. The branching half exists already (M7.2 worktrees + branches per session);
this is the workflow half. Pick the source session, see its diff against the
target, choose what to bring over (file-level v1, hunk-level v2), let it apply
cleanly or surface conflicts, and write a commit message generated from the
session's own transcript so the target's git history actually explains *why*
each change happened.

This solves the wishlist's #1 ask: branching with merge-back. It also unlocks
parallel experimentation as a real workflow — three sessions try three
approaches, you compare diffs side by side, promote the winner, kill the
losers. Today, sessions branch and die. After this, sessions branch, merge,
and history accrues.

## Decisions locked in

| Question | Choice |
|---|---|
| User-facing verb | **Promote** — implies "pick what you want, apply to target" (reserve "Merge" for a future true `git merge` flow) |
| Granularity v1 | **File-level cherry-pick** with checkboxes per changed file |
| Granularity v2 | **Hunk-level** within file, deferred to M9.9 |
| Apply mechanism | **`git diff <baseSha>..<HEAD> -- <selected> \| git apply`** in target worktree, after auto-committing source |
| Source must be… | **`idle` status** (green dot from M7.5). Promote button disabled if source is `working` / `blocked` / `error`. |
| Target default | **`main` session** (the original folder, on HEAD's branch). User can pick any other open session via dropdown. |
| Conflicts | **Pre-flight dry-run.** If conflicts, surface in the file list with a 🟥 marker; clicking opens the file in the editor with conflict markers. Promote disabled until clean. |
| Commit in source | **Auto-commit pending changes** before promote, with summary message from transcript |
| Commit in target | **One commit per promote**, message auto-drafted, always editable |
| Source after promote | **Stays alive by default.** Optional checkbox: "Close source after promote" → runs M7.2 cleanup |
| UI shape | **Full-screen modal takeover.** Editor area swaps to a diff view; tabs and bottom drawer stay accessible |
| Trigger | Right-click session tab → "Promote…" + global "Compare sessions" toolbar action |
| "Promote findings" (no code) | **Yes, separate action.** Generates session summary markdown → drops into target session's pinned files via PLAN_CONTEXT.md `pins.json` |

## Why "promote" not "merge"

`git merge` brings everything across, including ten experiments Claude tried,
two reverts, and the time it accidentally `rm`'d a file and added it back.
That's not what users want from a session merge. They want the *outcome* —
the final state of selected files — applied to the target as a single,
explainable commit. Promote = "this session figured something out, carry the
result forward." Merge = "preserve every step." We optimize for the first
because that's what the wishlist actually asks for. A future M9.X can add a
literal `git merge` action for the rare case someone wants the full branch.

## Architecture

### Promote modal layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Promote session 2 → main           [Cancel]                       [Promote] │
├──────────────────────────────────────────────────────────────────────────────┤
│  Source: session 2 (claude-vim/01HX…)  •  idle 🟢  •  baseSha 7a3f2…         │
│  Target: main (branch: feature/foo)    •  idle 🟢  •  HEAD 8b1d4…    [▾]    │
├────────────────────┬─────────────────────────────────────────────────────────┤
│ ☑ src/App.tsx     │   diff view (unified ▾ / side-by-side)                  │
│ ☑ src/Editor.tsx  │  ┌──────────────────────────────────────────────────┐   │
│ ☐ PLAN_CONTEXT.md │  │ - const x = 1                                    │   │
│ 🟥 src/types.ts   │  │ + const x = 2                                    │   │
│   (conflict)      │  │   ...                                            │   │
│                    │  └──────────────────────────────────────────────────┘   │
│ [Select all]       │                                                          │
│ [Deselect all]     │   👁 Open in editor   ↺ Refresh diff                    │
├────────────────────┴─────────────────────────────────────────────────────────┤
│  Commit message  ✏                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │ Promote session 2: refactor App.tsx state model                    │     │
│  │                                                                    │     │
│  │ Session findings:                                                  │     │
│  │ - Replaced useState pair with useReducer for editor flags         │     │
│  │ - Editor.tsx now subscribes to a single store                     │     │
│  │                                                                    │     │
│  │ ☐ Include full transcript in commit body                          │     │
│  │ ☐ Close source session after promote                              │     │
│  └────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────┘
```

When triggered: editor + tree dim and slide; modal takes over center. Tab bar
and bottom drawer (PLAN_CONTEXT.md) remain interactive — you can still chat
with the source session if you need it to explain or fix something mid-review.

### Promote pipeline

```
[Promote button] ─►
  1. Validate source status == idle           (else: disable + tooltip)
  2. Auto-commit source pending changes        (git -C <src> add -A && commit -m "<auto>")
  3. Stash target uncommitted (if any)         (git -C <tgt> stash push -u -m "claude-vim: pre-promote")
  4. For each selected file:
       git -C <src> diff <baseSha>..HEAD -- <file>  >  /tmp/promote-<id>.patch
  5. Dry-run:  git -C <tgt> apply --check  /tmp/promote-<id>.patch
       ├─ clean:    proceed
       └─ conflict: open conflict file in editor, halt, surface 🟥 marker
  6. Apply:    git -C <tgt> apply  /tmp/promote-<id>.patch
  7. Commit:   git -C <tgt> add <selected> && git -C <tgt> commit -m "<message>"
  8. Restore:  git -C <tgt> stash pop  (if step 3 ran)
  9. Optional: M7.2 cleanup on source     (if "Close source" checked)
 10. Emit:     session:promoted event → toast → close modal
```

Failure at any step: rollback (`git -C <tgt> reset --hard <pre-promote-sha>`,
`git -C <tgt> stash pop`), surface error, leave source untouched.

### Source-session auto-commit message

Generated from the source session's JSONL transcript at
`~/.claude/projects/<slug>/<sid>.jsonl` (same source as PLAN_CONTEXT.md):

- **Subject** (≤72 chars): the first user prompt of the session, truncated.
  E.g. user said "refactor App.tsx to use useReducer" → subject becomes
  `wip: refactor App.tsx to use useReducer`.
- **Body**: list of files touched + line counts + the last assistant turn's
  one-line summary (extract first sentence).

This is just the *source* commit. The user rarely sees it directly — it gets
squashed into the promote commit. We still write a real one because cherry-pick
needs commits to operate on if we ever switch from patch-apply to cherry-pick.

### Promote commit message (the one users care about)

Auto-drafted from the session transcript using a deterministic template, not
an LLM call (no extra cost, no latency):

```
Promote session <name>: <subject>

Session findings:
<bulleted list of distinct file changes, derived from
 (a) git diff stats per file
 (b) the last assistant message that mentioned each file's path>

Promoted from claude-vim/<id> @ <short-sha>.
```

If user toggles "Include full transcript in commit body": appends a `---`
separator and a markdown rendering of the user/assistant turns. Useful for
PRs where reviewers want to see the prompt that produced the change.

### Conflict resolution

Pre-flight `git apply --check` per file. Three outcomes per file:
- ✅ clean: checkbox enabled
- 🟥 conflict: file row gets red marker; clicking it opens the file in the
  editor in the **target's worktree** with conflict markers (`<<<<<<<` / `=======` /
  `>>>>>>>`) — we synthesize them by writing the target's current contents
  bracketed against the patch's intended contents.
- ⚠ deleted-then-modified: source deleted file that target modified, or
  vice-versa. Treat as conflict; user picks delete/keep in modal.

Promote button stays disabled while any selected file has unresolved conflicts.
Once user fixes in editor and saves, we re-run `git apply --check` against
the manually-resolved file (now part of target's working tree, so we
short-circuit: just stage and skip the patch step for that file).

### Compare-only mode (no promote)

Same modal, no Promote button. Just diff view. Used when:
- Three sessions running in parallel, you want to look at all of them
- Reviewing what a session did before deciding whether to promote
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

## UI changes (component-level)

- **`src/components/PromoteModal.tsx`** (new) — root component, manages source/target
  selection, file list, diff pane, message editor, promote action.
- **`src/components/DiffView.tsx`** (new) — unified + side-by-side diff
  rendering. Reuses CodeMirror 6 for syntax-highlighted diff text. Probably
  pulls in `@codemirror/merge` for side-by-side.
- **`src/components/CommitMessageEditor.tsx`** (new) — small editable textarea
  with subject/body split, character counter on subject.
- **`src/components/ConflictPrompt.tsx`** (new) — modal-within-modal when a
  conflict is detected and user clicks the file row.
- **`src/components/SessionTabs.tsx`** — add right-click context menu items:
  "Promote…", "Compare with…", "Promote findings →".
- **`src/hooks/usePromote.ts`** (new) — orchestrates the pipeline, surfaces
  status (validating / committing / dry-run / applying / done / error).
- **`src/App.tsx`** — render `PromoteModal` when active; dim main UI behind it.

### Rust changes

- **`src-tauri/src/promote.rs`** (new) — Tauri commands:
  - `promote_dry_run(source_id, target_id, files) -> { clean: [...], conflicts: [...] }`
  - `promote_apply(source_id, target_id, files, message, close_source) -> Result<sha, Error>`
  - `compare_sessions(a_id, b_id) -> Vec<FileChange>`
  - `auto_commit_source(source_id) -> sha`
  - `generate_promote_message(source_id, target_id, files) -> { subject, body }`
- **`src-tauri/src/git.rs`** — extend with: `diff_between`, `apply_patch`,
  `apply_check`, `stash_push`, `stash_pop`, `commit_with_message`. Most are
  thin wrappers around `git2` or shelling out to `git`.

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

This plan is small precisely because so much of the machinery already exists.

## Milestones

| # | Goal | Done when |
|---|------|-----------|
| **M9.1** | Promote modal shell + file list | Right-click tab → "Promote…" opens modal. Source + target shown. Changed files listed with checkboxes. Cancel returns to main UI. |
| **M9.2** | Unified diff view per file | Click a file → unified diff renders in modal's right pane. Syntax highlighting via CodeMirror. |
| **M9.3** | Auto-commit source + apply selected to target | Pipeline steps 1–7 wired. Default commit message used. Toast on success. Manual rollback on failure. |
| **M9.4** | Auto-generated commit message | Subject + body drafted from JSONL + diff stats. Editable in the message editor. "Include transcript" checkbox appends full markdown. |
| **M9.5** | Conflict pre-flight + resolution | Dry-run on file selection. Conflicts marked 🟥. Clicking opens file in editor with synthesized merge markers. Promote disabled until clean. |
| **M9.6** | Target dropdown | Switch target away from main → any other open session. baseSha math recomputed. |
| **M9.7** | Side-by-side diff toggle | Switch unified ↔ side-by-side. Persist preference per-session in localStorage. |
| **M9.8** | Compare-only mode | Global "Compare sessions" toolbar opens the modal with two source dropdowns and no Promote button. |
| **M9.9** | Hunk-level selection (v2) | Per-hunk checkboxes inside each file diff. Selected hunks reconstructed into a partial patch via `git apply --include`. |
| **M9.10** | Promote findings (no code) | Right-click → "Promote findings → main" generates summary markdown, writes to target worktree, appends to target `pins.json`. Toast: "Findings pinned to main session." |
| **M9.11** | Close-source-after-promote checkbox | If checked, runs M7.2 worktree+branch cleanup on success. |
| **M9.12** | Stash + restore target uncommitted | Pipeline step 3 + 8 wired. If target has uncommitted work, surface a warning before stashing; "Don't stash, abort" option. |

Estimate: 8–11 evenings end-to-end. M9.1–M9.5 is the core (file-level cherry-pick
with conflict handling — the headline workflow). M9.6–M9.8 round out the
selection/comparison surface. M9.9 is genuinely v2 territory. M9.10 is
the cross-link to PLAN_CONTEXT.md and is high-leverage on its own.

## Risks / unknowns

- **Conflicts will be the thing.** Most painful UX in any merge tool. Our bet:
  pre-flight dry-run + open-in-editor with synthesized markers is enough.
  Backup: ship a "I'll resolve manually in a terminal, come back when done"
  escape hatch — modal stays open, user fixes in their own shell, clicks
  "Re-check."
- **`git apply` is finicky.** Whitespace mismatches, missing context lines,
  binary files. Mitigation: `--3way` flag for richer recovery; for binary
  files (images, PDFs), fall back to direct file copy + commit.
- **Target with uncommitted work.** Stashing is correct but invisible can
  feel scary. Mitigation: explicit warning before step 3 ("This will stash
  N modified files in main. They'll be restored after."), one-click "Abort."
- **Source mid-edit.** Auto-commit step 2 captures whatever is on disk —
  could be a half-finished thought. Mitigation: only allow promote when
  source status == idle (M7.5 already gives us this). If user wants to
  promote mid-work, they need to first prompt their source session to
  stop and confirm completeness.
- **Branch divergence.** If main has moved a lot since the source branched,
  the diff context can be wrong. Mitigation v1: warn if source's baseSha is
  > 50 commits behind target HEAD. v2: offer "rebase source onto target"
  before promote.
- **Two sessions edited the same file.** Last-promoter-wins semantics. v1:
  the second promote will conflict, surface that, let user reconcile in
  editor. v2: a "merge sessions" three-way action.
- **Auto-message quality.** Templated, not LLM-generated, so messages can
  be terse or repetitive. Mitigation: always editable; quality bar is "good
  enough that the user just hits Enter 80% of the time."
- **`git apply` security.** Patch with `..` paths could write outside target
  worktree. Mitigation: validate paths before apply (must be relative,
  must not contain `..`), use `--unsafe-paths=false` (default), reject patches
  that touch `.git/`, `.claude-vim/`, or `.claude/`.
- **Worktree-local config interplay.** Target worktree's hooks fire during
  apply (e.g., a pre-commit hook could fail). Mitigation: respect hooks by
  default; offer a "skip hooks (--no-verify)" toggle for power users.

## Open issues for later

- True `git merge` action (preserve full history) as a separate menu item
  for when the user genuinely wants the experiment commits in main
- Three-way merge UI for the "two sessions edited same file" case
- "Promote queue" — line up multiple source sessions, batch promote in order
- Auto-rebase source onto target before promote (cleaner diff)
- Branch graph visualization across all sessions in the workspace
- Open a PR directly from the modal (push branch + `gh pr create` with the
  promote message as the body)
- Annotate diff hunks with "Claude said this about this hunk" — pull the
  reasoning from the JSONL turn that produced the edit
- "Suggest target" — heuristic: if source touched files that overlap with
  another session's changes, suggest that session as target instead of main
- Promote-and-keep-discussing — keep the source session's PTY alive after
  promote so the user can ask follow-ups about what was promoted
- Hook for "post-promote" so users can wire up custom actions (test runs,
  Slack notify, etc.)
- Cross-worktree `git mv` detection — if a session renamed a file, the
  promote should preserve rename history rather than apply as
  delete-then-add
