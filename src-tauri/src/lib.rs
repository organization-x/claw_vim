mod fs;
mod git;
mod hooks;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .setup(|app| {
            // Start the hooks HTTP server so child claude processes can call back.
            if let Err(e) = hooks::start_server(app.handle().clone()) {
                eprintln!("[claude-vim] failed to start hooks server: {}", e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::read_dir_tree,
            fs::read_file_text,
            fs::write_file_text,
            git::git_check_repo,
            git::git_init,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_status,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::claude_path,
            hooks::hooks_endpoint,
            hooks::install_session_hooks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
