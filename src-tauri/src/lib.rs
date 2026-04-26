mod fs;
mod git;
mod hooks;
mod pty;
mod setup;

use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::Manager;

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
            // Install a menu that omits the system "Close Window" item so its
            // Cmd+W accelerator doesn't fire alongside our in-app session-close
            // handler (which would close the only window and quit the app).
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
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
            git::git_diff_for_file,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::claude_path,
            hooks::hooks_endpoint,
            hooks::install_session_hooks,
            setup::system_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let cfg = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: cfg.bundle.copyright.clone(),
        authors: cfg.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    // Window submenu — Tauri's default includes close_window here, which binds
    // Cmd+W. We omit it so the frontend's keydown handler can own that shortcut.
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let help = Submenu::with_items(app, "Help", true, &[])?;
    #[cfg(not(target_os = "macos"))]
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&PredefinedMenuItem::about(app, None, Some(about))?],
    )?;

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&edit, &window, &help])?;

    Ok(menu)
}
