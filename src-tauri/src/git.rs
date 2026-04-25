use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git {:?} failed to spawn: {}", args, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {:?}: {}", args, stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
    let raw = run_git(&p, &["status", "--porcelain"])?;
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
    Ok(entries)
}
