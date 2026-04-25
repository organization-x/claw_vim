use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Default)]
pub struct ResolvedEnv {
    pub claude: Option<String>,
    pub path: Option<String>,
}

// Cached login-shell resolution. Cached because it costs ~200ms (forks
// a login shell), and is invoked on every PTY spawn. The setup screen's
// "Recheck" action calls `invalidate_resolve_cache` so the user can
// install `claude` and have us pick it up without restarting the app.
static RESOLVED: Mutex<Option<ResolvedEnv>> = Mutex::new(None);

pub fn invalidate_resolve_cache() {
    *RESOLVED.lock().unwrap() = None;
}

/// Common per-user install locations we probe directly. Some of these
/// (notably `~/.local/bin` and `~/.npm-global/bin`) aren't always on the
/// login-shell PATH, so we check them ourselves as a fallback.
fn common_bin_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::PathBuf::from(&home);
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".nvm/versions/node").join("default/bin"));
    }
    dirs.push(std::path::PathBuf::from("/opt/homebrew/bin"));
    dirs.push(std::path::PathBuf::from("/usr/local/bin"));
    dirs
}

fn probe_common_locations() -> Option<String> {
    for d in common_bin_dirs() {
        let candidate = d.join("claude");
        if candidate.is_file() {
            // Confirm it's actually executable
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&candidate) {
                    if meta.permissions().mode() & 0o111 == 0 {
                        continue;
                    }
                }
            }
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn login_shell_resolve() -> ResolvedEnv {
    let claude_direct = Command::new("which")
        .arg("claude")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let claude = claude_direct
        .or_else(|| {
            Command::new(&shell)
                .args(["-l", "-c", "command -v claude"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        // Last resort: probe well-known per-user install dirs so we work
        // even if the user's login shell PATH doesn't include them.
        .or_else(probe_common_locations);

    let mut path = Command::new(&shell)
        .args(["-l", "-c", "echo -n $PATH"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();

    // Ensure the common bin dirs are in the PATH we hand to the spawned
    // claude — otherwise tools claude itself shells out to (node, git,
    // ripgrep, etc.) may be missing even when we found claude itself.
    for dir in common_bin_dirs() {
        if let Some(s) = dir.to_str() {
            if !path.split(':').any(|p| p == s) && std::path::Path::new(s).exists() {
                if !path.is_empty() {
                    path.push(':');
                }
                path.push_str(s);
            }
        }
    }

    ResolvedEnv {
        claude,
        path: if path.is_empty() { None } else { Some(path) },
    }
}

pub fn resolve_env() -> ResolvedEnv {
    let mut guard = RESOLVED.lock().unwrap();
    if let Some(env) = guard.as_ref() {
        return env.clone();
    }
    let env = login_shell_resolve();
    *guard = Some(env.clone());
    env
}

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Arc<Mutex<PtySession>>>>,
}

#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
}

#[derive(Deserialize)]
pub struct SpawnArgs {
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    args: SpawnArgs,
) -> Result<String, String> {
    let env = resolve_env();
    let claude = env
        .claude
        .clone()
        .ok_or_else(|| "claude binary not found in PATH or via login shell.".to_string())?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&claude);
    cmd.cwd(&args.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(p) = env.path.clone() {
        cmd.env("PATH", p);
    } else if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = format!(
        "pty-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );

    let session = Arc::new(Mutex::new(PtySession {
        writer,
        master: pair.master,
        child,
    }));

    state
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), session);

    let app_clone = app.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_clone.emit(
                        "pty:data",
                        PtyData {
                            id: id_clone.clone(),
                            data: chunk,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit("pty:exit", PtyExit { id: id_clone });
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id).cloned()
    };
    let session = session.ok_or_else(|| format!("unknown pty id: {}", id))?;
    let mut s = session.lock().unwrap();
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<PtyState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id).cloned()
    };
    let session = session.ok_or_else(|| format!("unknown pty id: {}", id))?;
    let s = session.lock().unwrap();
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().remove(&id);
    if let Some(session) = session {
        let mut s = session.lock().unwrap();
        let _ = s.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn claude_path() -> Option<String> {
    resolve_env().claude
}
