use once_cell::sync::OnceCell;
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug)]
pub struct HooksEndpoint {
    pub port: u16,
    pub token: String,
}

static ENDPOINT: OnceCell<HooksEndpoint> = OnceCell::new();

const MARKER: &str = "# claude-vim:status-hook";

#[derive(Serialize, Clone)]
struct StatusEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
    status: String,
}

fn random_token() -> String {
    let mut rng = rand::rng();
    (0..32)
        .map(|_| {
            let n = rng.random_range(0..36u8);
            if n < 10 {
                (b'0' + n) as char
            } else {
                (b'a' + n - 10) as char
            }
        })
        .collect()
}

fn parse_form(body: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
        out.insert(k.into_owned(), v.into_owned());
    }
    out
}

fn event_to_status(event: &str) -> Option<&'static str> {
    match event {
        // Yellow — Claude is doing work. PreToolUse covers the case where
        // Claude resumes after the user grants permission (we want to flip
        // back to yellow even though no new prompt was submitted).
        "user_prompt_submit" => Some("working"),
        "pre_tool_use" => Some("working"),
        // Red — Claude is paused waiting for the user (permission prompt,
        // or any other Notification).
        "notification" => Some("blocked"),
        // Green — Claude finished the response.
        "stop" => Some("idle"),
        _ => None,
    }
}

pub fn start_server(app: AppHandle) -> Result<HooksEndpoint, String> {
    let token = random_token();
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("hooks server bind: {}", e))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|s| s.port())
        .ok_or_else(|| "hooks server: no port".to_string())?;

    let endpoint = HooksEndpoint {
        port,
        token: token.clone(),
    };
    ENDPOINT.set(endpoint.clone()).ok();

    let app_clone = app.clone();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);

            let params = parse_form(&body);
            let supplied = params.get("token").cloned().unwrap_or_default();
            if supplied != token {
                let _ = req.respond(
                    tiny_http::Response::from_string("forbidden").with_status_code(403),
                );
                continue;
            }

            let session = params.get("session").cloned().unwrap_or_default();
            let event = params.get("event").cloned().unwrap_or_default();
            if let Some(status) = event_to_status(&event) {
                let _ = app_clone.emit(
                    "session:status",
                    StatusEvent {
                        session_id: session,
                        status: status.to_string(),
                    },
                );
            }

            let _ = req.respond(tiny_http::Response::from_string("ok"));
        }
    });

    Ok(endpoint)
}

#[derive(Serialize)]
pub struct EndpointInfo {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub fn hooks_endpoint() -> Option<EndpointInfo> {
    ENDPOINT.get().map(|e| EndpointInfo {
        port: e.port,
        token: e.token.clone(),
    })
}

fn build_hook_entry(
    ep: &HooksEndpoint,
    session_id: &str,
    event_label: &str,
) -> serde_json::Value {
    // The marker MUST come after the curl — putting it at the start makes
    // the whole command a shell comment, which is exactly the bug we hit.
    let cmd = format!(
        "curl -s -X POST 'http://127.0.0.1:{port}/hook' -d 'session={sid}&event={event}&token={token}' >/dev/null 2>&1 || true {marker}",
        marker = MARKER,
        port = ep.port,
        sid = session_id,
        event = event_label,
        token = ep.token,
    );
    serde_json::json!({
        "hooks": [{"type": "command", "command": cmd}]
    })
}

fn has_marker(item: &serde_json::Value) -> bool {
    item.get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains(MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Inject (or refresh) status hooks for `session_id` into
/// `<folder>/.claude/settings.local.json`. Existing hooks not authored by
/// claude-vim are preserved. Idempotent: re-running replaces our prior
/// entries rather than appending.
pub fn install_hooks_for(folder: &Path, session_id: &str) -> Result<(), String> {
    let ep = ENDPOINT.get().ok_or("hooks server not running")?;
    install_hooks_with(folder, session_id, ep)
}

/// Internal core of `install_hooks_for`, parameterized on the endpoint
/// so unit tests can supply a fake one without starting the real server.
pub fn install_hooks_with(
    folder: &Path,
    session_id: &str,
    ep: &HooksEndpoint,
) -> Result<(), String> {
    let claude_dir = folder.join(".claude");
    let settings_path = claude_dir.join("settings.local.json");

    let mut root: serde_json::Value = if settings_path.exists() {
        let raw = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }
    let root_map = root.as_object_mut().unwrap();
    let hooks_val = root_map
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !hooks_val.is_object() {
        *hooks_val = serde_json::json!({});
    }
    let hooks = hooks_val.as_object_mut().unwrap();

    for (event_key, event_label) in [
        ("UserPromptSubmit", "user_prompt_submit"),
        ("PreToolUse", "pre_tool_use"),
        ("Stop", "stop"),
        ("Notification", "notification"),
    ] {
        let arr_val = hooks
            .entry(event_key.to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !arr_val.is_array() {
            *arr_val = serde_json::json!([]);
        }
        let arr = arr_val.as_array_mut().unwrap();
        arr.retain(|item| !has_marker(item));
        arr.push(build_hook_entry(ep, session_id, event_label));
    }

    std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn install_session_hooks(folder: String, session_id: String) -> Result<(), String> {
    install_hooks_for(Path::new(&folder), &session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fake_endpoint() -> HooksEndpoint {
        HooksEndpoint {
            port: 12345,
            token: "test-token".to_string(),
        }
    }

    fn temp_subdir(label: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!(
            "claude-vim-test-{label}-{pid}-{n}",
            label = label,
            pid = pid,
            n = n,
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn read_settings(folder: &Path) -> serde_json::Value {
        let raw = std::fs::read_to_string(folder.join(".claude/settings.local.json"))
            .expect("settings file should exist");
        serde_json::from_str(&raw).expect("settings should parse as JSON")
    }

    fn marker_count_in_event(settings: &serde_json::Value, event: &str) -> usize {
        settings["hooks"][event]
            .as_array()
            .map(|arr| arr.iter().filter(|item| has_marker(item)).count())
            .unwrap_or(0)
    }

    // ---- event_to_status ----

    #[test]
    fn event_to_status_user_prompt_submit_is_working() {
        assert_eq!(event_to_status("user_prompt_submit"), Some("working"));
    }

    #[test]
    fn event_to_status_pre_tool_use_is_working() {
        // Critical: covers "Claude resumed after permission" — must flip
        // the dot back to yellow without waiting for a new user prompt.
        assert_eq!(event_to_status("pre_tool_use"), Some("working"));
    }

    #[test]
    fn event_to_status_stop_is_idle() {
        assert_eq!(event_to_status("stop"), Some("idle"));
    }

    #[test]
    fn event_to_status_notification_is_blocked() {
        assert_eq!(event_to_status("notification"), Some("blocked"));
    }

    #[test]
    fn event_to_status_unknown_is_none() {
        assert_eq!(event_to_status("nope"), None);
        assert_eq!(event_to_status(""), None);
    }

    // ---- parse_form ----

    #[test]
    fn parse_form_basic() {
        let m = parse_form("a=1&b=2");
        assert_eq!(m.get("a"), Some(&"1".to_string()));
        assert_eq!(m.get("b"), Some(&"2".to_string()));
    }

    #[test]
    fn parse_form_url_decodes() {
        // tokens may legitimately include reserved chars
        let m = parse_form("token=abc%2Bdef%20ghi&session=s-1");
        assert_eq!(m.get("token"), Some(&"abc+def ghi".to_string()));
        assert_eq!(m.get("session"), Some(&"s-1".to_string()));
    }

    #[test]
    fn parse_form_empty() {
        assert!(parse_form("").is_empty());
    }

    // ---- has_marker ----

    #[test]
    fn has_marker_finds_our_hook() {
        let entry = serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": format!("curl -s ... {}", MARKER)
            }]
        });
        assert!(has_marker(&entry));
    }

    #[test]
    fn has_marker_misses_user_hook() {
        let entry = serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": "echo hello"
            }]
        });
        assert!(!has_marker(&entry));
    }

    #[test]
    fn has_marker_handles_empty_hooks_array() {
        let entry = serde_json::json!({"hooks": []});
        assert!(!has_marker(&entry));
    }

    // ---- build_hook_entry shape ----

    #[test]
    fn build_hook_entry_starts_with_curl_and_ends_with_marker() {
        let ep = fake_endpoint();
        let entry = build_hook_entry(&ep, "s-abc", "stop");
        let cmd = entry["hooks"][0]["command"]
            .as_str()
            .expect("command string");
        assert!(
            cmd.starts_with("curl "),
            "command must start with curl, got: {}",
            cmd
        );
        assert!(
            cmd.trim_end().ends_with(MARKER),
            "command must end with marker so the curl actually runs, got: {}",
            cmd
        );
    }

    #[test]
    fn build_hook_entry_includes_session_event_token_port() {
        let ep = fake_endpoint();
        let entry = build_hook_entry(&ep, "s-abc", "stop");
        let cmd = entry["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("session=s-abc"));
        assert!(cmd.contains("event=stop"));
        assert!(cmd.contains("token=test-token"));
        assert!(cmd.contains(":12345/"));
    }

    // ---- install_hooks_with ----

    #[test]
    fn install_hooks_creates_settings_when_missing() {
        let dir = temp_subdir("create");
        let ep = fake_endpoint();
        install_hooks_with(&dir, "s-1", &ep).unwrap();
        let settings = read_settings(&dir);
        for event in ["UserPromptSubmit", "PreToolUse", "Stop", "Notification"] {
            assert_eq!(
                marker_count_in_event(&settings, event),
                1,
                "{} should have exactly one of our entries",
                event
            );
        }
    }

    #[test]
    fn install_hooks_is_idempotent() {
        let dir = temp_subdir("idempotent");
        let ep = fake_endpoint();
        install_hooks_with(&dir, "s-1", &ep).unwrap();
        install_hooks_with(&dir, "s-1", &ep).unwrap();
        install_hooks_with(&dir, "s-1", &ep).unwrap();
        let settings = read_settings(&dir);
        for event in ["UserPromptSubmit", "PreToolUse", "Stop", "Notification"] {
            assert_eq!(
                marker_count_in_event(&settings, event),
                1,
                "{} must stay at one entry after repeated installs",
                event
            );
        }
    }

    #[test]
    fn install_hooks_replaces_with_fresh_session_id() {
        // Re-installing with a different session id should leave only the
        // newer command in the file (the session id changes per app launch).
        let dir = temp_subdir("replace-id");
        let ep = fake_endpoint();
        install_hooks_with(&dir, "s-old", &ep).unwrap();
        install_hooks_with(&dir, "s-new", &ep).unwrap();
        let settings = read_settings(&dir);
        let stop_arr = settings["hooks"]["Stop"].as_array().unwrap();
        let our: Vec<_> = stop_arr.iter().filter(|i| has_marker(i)).collect();
        assert_eq!(our.len(), 1);
        let cmd = our[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("session=s-new"));
        assert!(!cmd.contains("session=s-old"));
    }

    #[test]
    fn install_hooks_preserves_user_hooks() {
        let dir = temp_subdir("preserve");
        let ep = fake_endpoint();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let user_settings = serde_json::json!({
            "hooks": {
                "UserPromptSubmit": [{
                    "hooks": [{ "type": "command", "command": "echo user-hook" }]
                }]
            },
            "env": { "MY_VAR": "1" }
        });
        std::fs::write(
            dir.join(".claude/settings.local.json"),
            serde_json::to_string_pretty(&user_settings).unwrap(),
        )
        .unwrap();

        install_hooks_with(&dir, "s-1", &ep).unwrap();
        let settings = read_settings(&dir);

        let arr = settings["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "user's hook + our hook should coexist");
        let user_kept = arr.iter().any(|item| {
            item["hooks"][0]["command"]
                .as_str()
                .map(|c| c == "echo user-hook")
                .unwrap_or(false)
        });
        assert!(user_kept, "user's command must survive install");
        assert_eq!(marker_count_in_event(&settings, "UserPromptSubmit"), 1);
        // Untouched top-level keys survive too.
        assert_eq!(settings["env"]["MY_VAR"].as_str(), Some("1"));
    }

    #[test]
    fn install_hooks_recovers_from_malformed_json() {
        let dir = temp_subdir("malformed");
        let ep = fake_endpoint();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(
            dir.join(".claude/settings.local.json"),
            "{this is not json",
        )
        .unwrap();
        // Should not error — we just fall back to {} and inject ours.
        install_hooks_with(&dir, "s-1", &ep).unwrap();
        let settings = read_settings(&dir);
        assert_eq!(marker_count_in_event(&settings, "Stop"), 1);
    }

    #[test]
    fn install_hooks_recovers_when_hooks_key_is_not_object() {
        let dir = temp_subdir("hooks-array");
        let ep = fake_endpoint();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(
            dir.join(".claude/settings.local.json"),
            r#"{"hooks": "this should be an object"}"#,
        )
        .unwrap();
        install_hooks_with(&dir, "s-1", &ep).unwrap();
        let settings = read_settings(&dir);
        assert!(settings["hooks"].is_object());
        assert_eq!(marker_count_in_event(&settings, "Stop"), 1);
    }

    // ---- random_token sanity ----

    #[test]
    fn random_token_is_32_alphanumeric() {
        let t = random_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn random_token_is_unique() {
        let a = random_token();
        let b = random_token();
        assert_ne!(a, b, "two tokens should not collide");
    }
}
