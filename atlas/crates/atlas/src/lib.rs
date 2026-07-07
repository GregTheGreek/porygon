// Tauri 2 entry point for the Porygon desktop shell.

/// Returns the crate version. Wired end-to-end to prove the IPC bridge; the
/// toolbar displays it.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
