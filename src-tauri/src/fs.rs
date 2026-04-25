use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<DirEntry>>,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".claude-vim",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".venv",
    "__pycache__",
    ".DS_Store",
];

fn read_dir_recursive(root: &Path, depth: usize) -> Vec<DirEntry> {
    if depth > 8 {
        return Vec::new();
    }
    let read = match fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut entries: Vec<DirEntry> = read
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }
            let path = entry.path();
            let path_str = path.to_string_lossy().to_string();
            let metadata = entry.metadata().ok()?;
            let is_dir = metadata.is_dir();
            let children = if is_dir {
                Some(read_dir_recursive(&path, depth + 1))
            } else {
                None
            };
            Some(DirEntry {
                name,
                path: path_str,
                is_dir,
                children,
            })
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    entries
}

#[tauri::command]
pub fn read_dir_tree(path: String) -> Result<Vec<DirEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    Ok(read_dir_recursive(&root, 0))
}

#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub fn write_file_text(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path, e))
}
