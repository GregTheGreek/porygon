// Tauri 2 entry point for the Porygon desktop shell.

mod project;
mod recents;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use project::{OpenProject, Project};
use recents::Recent;

/// Returns the crate version. Wired end-to-end to prove the IPC bridge; the
/// toolbar displays it.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Path to the recent-projects file inside the app config dir.
fn recents_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("recents.json"))
}

/// Record a project as the most-recent one, keeping the stored name in sync.
fn remember(app: &AppHandle, open: &OpenProject) -> Result<(), String> {
    let file = recents_file(app)?;
    let entry = Recent {
        path: open.path.clone(),
        name: open.project.name.clone(),
    };
    let updated = recents::push(recents::load(&file), entry, recents::RECENTS_CAP);
    recents::save(&file, &updated)
}

#[tauri::command]
fn create_project(app: AppHandle, location: String, name: String) -> Result<OpenProject, String> {
    let open = project::create(&location, &name).map_err(|e| e.to_string())?;
    remember(&app, &open)?;
    Ok(open)
}

#[tauri::command]
fn open_project(app: AppHandle, dir: String) -> Result<OpenProject, String> {
    let open = project::read(&dir).map_err(|e| e.to_string())?;
    remember(&app, &open)?;
    Ok(open)
}

#[tauri::command]
fn save_project(app: AppHandle, path: String, project: Project) -> Result<Project, String> {
    let saved = project::save(&path, project).map_err(|e| e.to_string())?;
    remember(
        &app,
        &OpenProject {
            path,
            project: saved.clone(),
        },
    )?;
    Ok(saved)
}

#[tauri::command]
fn get_recent_projects(app: AppHandle) -> Result<Vec<Recent>, String> {
    let file = recents_file(&app)?;
    let pruned = recents::prune(recents::load(&file));
    // Persist the pruning so stale entries do not reappear.
    recents::save(&file, &pruned)?;
    Ok(pruned)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            create_project,
            open_project,
            save_project,
            get_recent_projects
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
