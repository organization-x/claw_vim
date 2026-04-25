//! System-readiness checks shown to the user on first launch.
//!
//! `system_check` re-resolves PATH from the user's login shell (so it picks
//! up tools they've just installed) and runs `--version` against each
//! required dependency to confirm it's both findable and executable.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct CheckResult {
    pub ok: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct SystemCheck {
    pub claude: CheckResult,
    pub git: CheckResult,
}

#[tauri::command]
pub fn system_check() -> SystemCheck {
    // Drop the cached login-shell resolution so a freshly-installed
    // `claude` is detectable without restarting the app.
    crate::pty::invalidate_resolve_cache();
    SystemCheck {
        claude: check_claude(),
        git: check_git(),
    }
}

fn check_claude() -> CheckResult {
    let env = crate::pty::resolve_env();
    let path = match env.claude {
        Some(p) => p,
        None => {
            return CheckResult {
                ok: false,
                path: None,
                version: None,
                error: Some(
                    "`claude` CLI not found in PATH or via login shell.".into(),
                ),
            };
        }
    };

    let mut cmd = Command::new(&path);
    cmd.arg("--version");
    if let Some(p) = env.path.as_deref() {
        cmd.env("PATH", p);
    }

    match cmd.output() {
        Ok(out) if out.status.success() => CheckResult {
            ok: true,
            path: Some(path),
            version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            error: None,
        },
        Ok(out) => CheckResult {
            ok: false,
            path: Some(path),
            version: None,
            error: Some(format!(
                "`claude --version` failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
        },
        Err(e) => CheckResult {
            ok: false,
            path: Some(path),
            version: None,
            error: Some(format!("Could not exec claude: {}", e)),
        },
    }
}

fn check_git() -> CheckResult {
    match Command::new("git").arg("--version").output() {
        Ok(out) if out.status.success() => CheckResult {
            ok: true,
            path: None,
            version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            error: None,
        },
        _ => CheckResult {
            ok: false,
            path: None,
            version: None,
            error: Some(
                "`git` not found. Install via `xcode-select --install`.".into(),
            ),
        },
    }
}
