use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run_git_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git {:?} failed to spawn: {}", args, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {:?}: {}", args, stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    Ok(run_git_raw(cwd, args)?.trim().to_string())
}

#[derive(Serialize, Default)]
pub struct RepoInfo {
    #[serde(rename = "isRepo")]
    pub is_repo: bool,
    pub root: Option<String>,
    pub head: Option<String>,
    pub branch: Option<String>,
}

#[tauri::command]
pub fn git_check_repo(path: String) -> Result<RepoInfo, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let root = match run_git(&p, &["rev-parse", "--show-toplevel"]) {
        Ok(r) => r,
        Err(_) => {
            return Ok(RepoInfo {
                is_repo: false,
                ..Default::default()
            })
        }
    };
    let head = run_git(&p, &["rev-parse", "HEAD"]).ok();
    let branch = run_git(&p, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    Ok(RepoInfo {
        is_repo: true,
        root: Some(root),
        head,
        branch,
    })
}

#[tauri::command]
pub fn git_init(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    run_git(&p, &["init"])?;
    // Create an initial commit so HEAD exists — worktrees need it.
    let head_exists = run_git(&p, &["rev-parse", "HEAD"]).is_ok();
    if !head_exists {
        run_git(&p, &["commit", "--allow-empty", "-m", "claude-vim: initial commit"])?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    #[serde(rename = "baseSha")]
    pub base_sha: String,
}

fn ensure_gitignored(repo_root: &Path) {
    let gitignore = repo_root.join(".gitignore");
    let entry = ".claude-vim/";
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == entry || l.trim() == ".claude-vim") {
        return;
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(entry);
    updated.push('\n');
    let _ = std::fs::write(&gitignore, updated);
}

#[tauri::command]
pub fn git_worktree_add(
    repo: String,
    session_id: String,
) -> Result<WorktreeInfo, String> {
    let p = PathBuf::from(&repo);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", repo));
    }
    let root_str = run_git(&p, &["rev-parse", "--show-toplevel"])?;
    let root = PathBuf::from(&root_str);

    let storage = root.join(".claude-vim").join("worktrees");
    std::fs::create_dir_all(&storage).map_err(|e| e.to_string())?;
    ensure_gitignored(&root);

    let worktree_path = storage.join(&session_id);
    let branch = format!("claude-vim/{}", session_id);

    let path_str = worktree_path.to_string_lossy().to_string();
    run_git(
        &root,
        &["worktree", "add", &path_str, "-b", &branch, "HEAD"],
    )?;

    let base_sha = run_git(&worktree_path, &["rev-parse", "HEAD"])?;

    // Best-effort: install our status hooks so the new claude session
    // calls back to the in-app HTTP server for status updates.
    let _ = crate::hooks::install_hooks_for(&worktree_path, &session_id);

    Ok(WorktreeInfo {
        path: path_str,
        branch,
        base_sha,
    })
}

#[tauri::command]
pub fn git_worktree_remove(repo: String, path: String, branch: String) -> Result<(), String> {
    let repo_p = PathBuf::from(&repo);
    let _ = run_git(&repo_p, &["worktree", "remove", "--force", &path]);
    let _ = run_git(&repo_p, &["branch", "-D", &branch]);
    Ok(())
}

#[derive(Serialize)]
pub struct ChangeEntry {
    pub path: String,
    pub status: String,
}

/// Pure parser for `git status --porcelain` output. Extracted so it's
/// covered by unit tests without invoking git at all.
pub fn parse_status_porcelain(raw: &str) -> Vec<ChangeEntry> {
    let mut entries = Vec::new();
    for line in raw.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let rest = &line[3..];

        // Renames look like: "R  old -> new" — show the new path.
        let display_path = if let Some(idx) = rest.find(" -> ") {
            rest[idx + 4..].to_string()
        } else {
            rest.to_string()
        };

        let status = if xy == "??" {
            "untracked"
        } else if xy.contains('D') {
            "deleted"
        } else if xy.contains('A') {
            "added"
        } else {
            "modified"
        };

        entries.push(ChangeEntry {
            path: display_path,
            status: status.to_string(),
        });
    }
    entries
}

#[tauri::command]
pub fn git_status(path: String) -> Result<Vec<ChangeEntry>, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Ok(Vec::new());
    }
    // Bail quietly if this isn't a git working tree.
    if run_git(&p, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }
    // Important: do NOT trim — porcelain lines start with a leading space
    // when the staged column is empty (e.g. " M README.md"). Trimming
    // would shift the parse and lose the first character of the path.
    let raw = run_git_raw(&p, &["status", "--porcelain"])?;
    Ok(parse_status_porcelain(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_subdir(label: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!(
            "claude-vim-git-test-{label}-{pid}-{n}",
            label = label,
            pid = pid,
            n = n,
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Initialize a git repo in `dir` with a real initial commit.
    /// Sets author identity locally so commits work even when the user's
    /// global git config isn't set (CI, fresh dev machines).
    fn init_repo(dir: &PathBuf) {
        run_git(dir, &["init", "-q", "-b", "main"]).expect("git init");
        run_git(dir, &["config", "user.email", "test@example.com"])
            .expect("set email");
        run_git(dir, &["config", "user.name", "Test"]).expect("set name");
        run_git(dir, &["config", "commit.gpgsign", "false"])
            .expect("disable gpg sign");
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run_git(dir, &["add", "."]).expect("add");
        run_git(dir, &["commit", "-q", "-m", "init"]).expect("initial commit");
    }

    fn read_gitignore(dir: &PathBuf) -> String {
        std::fs::read_to_string(dir.join(".gitignore")).unwrap_or_default()
    }

    // ---- parse_status_porcelain ----

    #[test]
    fn parse_porcelain_empty_input() {
        assert_eq!(parse_status_porcelain("").len(), 0);
    }

    #[test]
    fn parse_porcelain_modified_unstaged() {
        let entries = parse_status_porcelain(" M src/foo.rs\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src/foo.rs");
        assert_eq!(entries[0].status, "modified");
    }

    #[test]
    fn parse_porcelain_modified_staged() {
        let entries = parse_status_porcelain("M  src/foo.rs\n");
        assert_eq!(entries[0].status, "modified");
    }

    #[test]
    fn parse_porcelain_modified_both() {
        let entries = parse_status_porcelain("MM src/foo.rs\n");
        assert_eq!(entries[0].status, "modified");
    }

    #[test]
    fn parse_porcelain_untracked() {
        let entries = parse_status_porcelain("?? new.txt\n");
        assert_eq!(entries[0].path, "new.txt");
        assert_eq!(entries[0].status, "untracked");
    }

    #[test]
    fn parse_porcelain_added_staged() {
        let entries = parse_status_porcelain("A  added.txt\n");
        assert_eq!(entries[0].status, "added");
    }

    #[test]
    fn parse_porcelain_deleted_unstaged() {
        let entries = parse_status_porcelain(" D gone.txt\n");
        assert_eq!(entries[0].status, "deleted");
    }

    #[test]
    fn parse_porcelain_deleted_staged() {
        let entries = parse_status_porcelain("D  gone.txt\n");
        assert_eq!(entries[0].status, "deleted");
    }

    #[test]
    fn parse_porcelain_rename_uses_new_path() {
        let entries = parse_status_porcelain("R  old/path.txt -> new/path.txt\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "new/path.txt");
        assert_eq!(entries[0].status, "modified");
    }

    #[test]
    fn parse_porcelain_skips_short_lines() {
        // tolerate a stray short line without panicking on byte slicing
        let entries = parse_status_porcelain("ab\n M src/foo.rs\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src/foo.rs");
    }

    #[test]
    fn parse_porcelain_multiple_entries_in_order() {
        let raw = "?? a\n M b\nA  c\n D d\n";
        let entries = parse_status_porcelain(raw);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].path, "a");
        assert_eq!(entries[0].status, "untracked");
        assert_eq!(entries[1].path, "b");
        assert_eq!(entries[1].status, "modified");
        assert_eq!(entries[2].path, "c");
        assert_eq!(entries[2].status, "added");
        assert_eq!(entries[3].path, "d");
        assert_eq!(entries[3].status, "deleted");
    }

    // ---- ensure_gitignored ----

    #[test]
    fn ensure_gitignored_creates_file_when_missing() {
        let dir = temp_subdir("gi-create");
        ensure_gitignored(&dir);
        let body = read_gitignore(&dir);
        assert!(body.contains(".claude-vim/"));
    }

    #[test]
    fn ensure_gitignored_appends_when_missing_entry() {
        let dir = temp_subdir("gi-append");
        std::fs::write(dir.join(".gitignore"), "node_modules\ntarget\n").unwrap();
        ensure_gitignored(&dir);
        let body = read_gitignore(&dir);
        assert!(body.contains("node_modules"));
        assert!(body.contains("target"));
        assert!(body.contains(".claude-vim/"));
    }

    #[test]
    fn ensure_gitignored_is_idempotent() {
        let dir = temp_subdir("gi-idempotent");
        ensure_gitignored(&dir);
        ensure_gitignored(&dir);
        ensure_gitignored(&dir);
        let body = read_gitignore(&dir);
        let occurrences = body.matches(".claude-vim/").count();
        assert_eq!(occurrences, 1, "got: {:?}", body);
    }

    #[test]
    fn ensure_gitignored_recognizes_unsuffixed_form() {
        // user already ignored the dir without trailing slash — don't double-add
        let dir = temp_subdir("gi-no-slash");
        std::fs::write(dir.join(".gitignore"), ".claude-vim\n").unwrap();
        ensure_gitignored(&dir);
        let body = read_gitignore(&dir);
        assert_eq!(body.matches(".claude-vim").count(), 1);
    }

    #[test]
    fn ensure_gitignored_handles_missing_trailing_newline() {
        let dir = temp_subdir("gi-no-newline");
        std::fs::write(dir.join(".gitignore"), "target").unwrap();
        ensure_gitignored(&dir);
        let body = read_gitignore(&dir);
        assert!(body.contains("target"));
        assert!(body.contains(".claude-vim/"));
        // we should have inserted a newline before our entry
        assert!(
            body.contains("target\n"),
            "missing newline separator: {:?}",
            body
        );
    }

    // ---- git_check_repo ----

    #[test]
    fn check_repo_on_non_repo_returns_false() {
        let dir = temp_subdir("check-no-repo");
        let info = git_check_repo(dir.to_string_lossy().into_owned()).unwrap();
        assert!(!info.is_repo);
        assert!(info.root.is_none());
        assert!(info.head.is_none());
    }

    #[test]
    fn check_repo_after_init_returns_true_with_metadata() {
        let dir = temp_subdir("check-after-init");
        init_repo(&dir);
        let info = git_check_repo(dir.to_string_lossy().into_owned()).unwrap();
        assert!(info.is_repo);
        assert!(info.head.is_some(), "HEAD should exist after a commit");
        assert_eq!(info.branch.as_deref(), Some("main"));
    }

    #[test]
    fn check_repo_on_missing_dir_errors() {
        let dir = std::env::temp_dir().join("definitely-not-a-real-dir-for-claude-vim");
        let result = git_check_repo(dir.to_string_lossy().into_owned());
        assert!(result.is_err());
    }

    // ---- git_init ----

    #[test]
    fn init_creates_repo_with_head() {
        let dir = temp_subdir("init");
        // Set git config locally — git_init doesn't, so we set ours by
        // doing the init via run_git directly for the user.email/name
        // bits.  But git_init creates HEAD via --allow-empty, which only
        // requires the local identity, so set it via env for the spawned git.
        // Easiest: pre-populate .git/config equivalent — just run init,
        // then set config, then call git_init again to make the commit.
        run_git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        run_git(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(&dir, &["config", "user.name", "Test"]).unwrap();
        run_git(&dir, &["config", "commit.gpgsign", "false"]).unwrap();

        // git_init should detect missing HEAD and create the initial commit
        git_init(dir.to_string_lossy().into_owned()).unwrap();
        let info = git_check_repo(dir.to_string_lossy().into_owned()).unwrap();
        assert!(info.is_repo);
        assert!(info.head.is_some(), "HEAD should exist after git_init");
    }

    #[test]
    fn init_is_safe_to_run_on_existing_repo() {
        let dir = temp_subdir("init-existing");
        init_repo(&dir);
        let head_before = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
        // Calling init again should not error and should not add a new commit
        git_init(dir.to_string_lossy().into_owned()).unwrap();
        let head_after = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head_before, head_after);
    }

    // ---- git_worktree_add / remove ----

    #[test]
    fn worktree_add_creates_dir_branch_and_gitignore_entry() {
        let dir = temp_subdir("wt-add");
        init_repo(&dir);

        let info = git_worktree_add(
            dir.to_string_lossy().into_owned(),
            "alpha".to_string(),
        )
        .unwrap();

        // Path layout: <repo>/.claude-vim/worktrees/<id>.
        // On macOS /var is a symlink to /private/var, so the path git
        // returns (canonical) and the path we joined ourselves can differ
        // textually but resolve to the same thing — canonicalize both.
        let expected_path = dir.join(".claude-vim").join("worktrees").join("alpha");
        let info_path_canon = std::fs::canonicalize(&info.path).unwrap();
        let expected_canon = std::fs::canonicalize(&expected_path).unwrap();
        assert_eq!(info_path_canon, expected_canon);
        assert!(expected_path.is_dir(), "worktree dir should exist");
        // Branch name is namespaced
        assert_eq!(info.branch, "claude-vim/alpha");
        // Branch actually exists in the repo
        let branches = run_git(&dir, &["branch", "--list", "claude-vim/alpha"]).unwrap();
        assert!(branches.contains("claude-vim/alpha"), "got: {:?}", branches);
        // baseSha is real
        assert_eq!(info.base_sha.len(), 40);
        // .gitignore now contains our marker
        let gi = read_gitignore(&dir);
        assert!(gi.contains(".claude-vim/"));
        // README from the original commit is present in the worktree
        assert!(expected_path.join("README.md").exists());
    }

    #[test]
    fn two_worktrees_with_distinct_ids_coexist() {
        let dir = temp_subdir("wt-two");
        init_repo(&dir);
        git_worktree_add(dir.to_string_lossy().into_owned(), "one".to_string()).unwrap();
        git_worktree_add(dir.to_string_lossy().into_owned(), "two".to_string()).unwrap();
        let listing = run_git(&dir, &["worktree", "list"]).unwrap();
        assert!(listing.contains("worktrees/one"), "got: {:?}", listing);
        assert!(listing.contains("worktrees/two"), "got: {:?}", listing);
    }

    #[test]
    fn worktree_remove_clears_dir_and_branch() {
        let dir = temp_subdir("wt-remove");
        init_repo(&dir);
        let info = git_worktree_add(
            dir.to_string_lossy().into_owned(),
            "victim".to_string(),
        )
        .unwrap();
        let wt_path = PathBuf::from(&info.path);
        assert!(wt_path.is_dir());

        git_worktree_remove(
            dir.to_string_lossy().into_owned(),
            info.path.clone(),
            info.branch.clone(),
        )
        .unwrap();

        assert!(!wt_path.exists(), "worktree dir should be gone");
        let branches = run_git(&dir, &["branch", "--list", "claude-vim/victim"]).unwrap();
        assert!(branches.is_empty(), "branch should be deleted, got: {:?}", branches);
    }

    // ---- git_status integration ----

    #[test]
    fn status_on_non_repo_is_empty() {
        let dir = temp_subdir("status-no-repo");
        let entries = git_status(dir.to_string_lossy().into_owned()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn status_on_clean_repo_is_empty() {
        let dir = temp_subdir("status-clean");
        init_repo(&dir);
        let entries = git_status(dir.to_string_lossy().into_owned()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn status_reports_modified_file() {
        let dir = temp_subdir("status-modified");
        init_repo(&dir);
        std::fs::write(dir.join("README.md"), "edited\n").unwrap();
        let entries = git_status(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "README.md");
        assert_eq!(entries[0].status, "modified");
    }

    #[test]
    fn status_reports_untracked_file() {
        let dir = temp_subdir("status-untracked");
        init_repo(&dir);
        std::fs::write(dir.join("brand-new.txt"), "x").unwrap();
        let entries = git_status(dir.to_string_lossy().into_owned()).unwrap();
        let new = entries
            .iter()
            .find(|e| e.path == "brand-new.txt")
            .expect("untracked file should appear");
        assert_eq!(new.status, "untracked");
    }
}
