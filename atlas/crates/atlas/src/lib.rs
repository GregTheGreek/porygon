// Tauri 2 entry point for the Porygon desktop shell.

mod artwork;
mod object;
mod project;
mod recents;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use artwork::Artwork;
use object::Object;
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

/// Read a PNG the user picked for the Canvas. Session-scoped: nothing is
/// persisted (Objects, M4, own artwork). Returns bytes (base64) + dimensions.
#[tauri::command]
fn read_artwork(path: String) -> Result<Artwork, String> {
    artwork::read(&path).map_err(|e| e.to_string())
}

/// Import a PNG as a new Object: copy it into `objects/<uuid>/artwork.png` and
/// return the Object metadata. The frontend adds it to project.json and saves.
#[tauri::command]
fn import_object(project_path: String, source_png: String, name: String) -> Result<Object, String> {
    object::import(&project_path, &source_png, &name).map_err(|e| e.to_string())
}

/// Duplicate an existing Object's artwork into a fresh directory, returning the
/// new Object (new UUID, "<name> copy"). The frontend has the source metadata.
#[tauri::command]
fn duplicate_object(project_path: String, source: Object) -> Result<Object, String> {
    object::duplicate(&project_path, &source).map_err(|e| e.to_string())
}

/// Soft-delete an Object: move its directory to `.trash/<uuid>` so undo can
/// restore it. The frontend removes it from project.json.
#[tauri::command]
fn trash_object(project_path: String, id: String) -> Result<(), String> {
    object::trash(&project_path, &id).map_err(|e| e.to_string())
}

/// Undo a soft-delete: move the object's directory back out of `.trash`.
#[tauri::command]
fn restore_object(project_path: String, id: String) -> Result<(), String> {
    object::restore(&project_path, &id).map_err(|e| e.to_string())
}

/// Read an Object's stored artwork (base64 + dimensions) for the Canvas.
#[tauri::command]
fn read_object_artwork(project_path: String, id: String) -> Result<Artwork, String> {
    object::read_artwork(&project_path, &id).map_err(|e| e.to_string())
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
            read_artwork,
            import_object,
            duplicate_object,
            trash_object,
            restore_object,
            read_object_artwork,
            get_recent_projects
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
