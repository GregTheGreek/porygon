// Tauri 2 entry point for the Porygon desktop shell.

mod artwork;
mod budgets;
mod collision;
mod exporter;
mod object;
mod occlusion;
mod pokemon_emerald;
mod porytiles;
mod prefabs;
mod project;
mod recents;
mod settings;
mod tileset;
mod validity;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use artwork::Artwork;
use budgets::TilesetBudget;
use exporter::ExportResult;
use object::Object;
use pokemon_emerald::CollisionTag;
use porytiles::{BinaryStatus, CompileResult};
use project::{OpenProject, Project};
use recents::Recent;
use settings::Settings;
use tileset::Tileset;
use validity::Problem;

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

/// Path to the app settings file inside the app config dir.
fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
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

/// The custom collision-tag vocabulary from the pokemon_emerald engine module.
/// The frontend's Custom-tag dropdown consumes this; the list is never
/// hardcoded in TypeScript (the Bible requires it to come from the engine).
#[tauri::command]
fn collision_tags() -> Vec<CollisionTag> {
    pokemon_emerald::collision_tags()
}

/// Tier 1 (Object) validity problems for one Object, in artist terms. The
/// Inspector renders these in its Problems section. Empty means coherent.
#[tauri::command]
fn object_problems(object: Object) -> Vec<Problem> {
    validity::object_problems(&object)
}

/// Mint a fresh, empty Tileset (new UUID, given name). Id generation lives in
/// Rust for parity with Objects (import mints the object UUID); the frontend
/// adds the returned Tileset to project.json and saves, and owns the rest of
/// tileset CRUD as plain undoable list edits (a Tileset owns no files on disk).
#[tauri::command]
fn create_tileset(name: String) -> Tileset {
    Tileset::new(&name)
}

/// Tier 2 (Tileset) budget prediction for one tileset, in artist terms. Reads
/// the tileset's member artwork from disk and returns palette/tile/metatile
/// meters plus any budget problems. This is the mandatory palette pre-check:
/// exceeding the palette budget crashes Porytiles, so Atlas predicts it here
/// before any compile ever runs.
#[tauri::command]
fn tileset_budget(project_path: String, tileset_id: String) -> Result<TilesetBudget, String> {
    budgets::compute_for_tileset(&project_path, &tileset_id)
}

/// Export a tileset per compiler.md (M10): write the Porytiles-ready source
/// tree plus one Compiled Object (.atlasobject) per member into
/// `<dest_dir>/<tileset-slug>/`. Refuses with the validity problems (and writes
/// nothing) when the tileset is not exportable. Reads project state from disk
/// and never mutates it - export is not undoable and outside autosave.
#[tauri::command]
fn export_tileset(
    project_path: String,
    tileset_id: String,
    dest_dir: String,
) -> Result<ExportResult, String> {
    exporter::export_tileset(&project_path, &tileset_id, &dest_dir)
}

/// The persisted app settings (currently just the Porytiles binary path).
#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(settings::load(&settings_file(&app)?))
}

/// Override the Porytiles binary path (or clear it to fall back to the default).
/// Persisted app-side like recents; returns the saved settings.
#[tauri::command]
fn set_porytiles_path(app: AppHandle, path: Option<String>) -> Result<Settings, String> {
    let file = settings_file(&app)?;
    let mut current = settings::load(&file);
    current.porytiles_path = path.filter(|p| !p.trim().is_empty());
    settings::save(&file, &current)?;
    Ok(current)
}

/// Check the configured Porytiles binary: is it present and exactly the pinned
/// version? Drives the compile-readiness UI. Never fails; a missing or wrong
/// binary comes back as `ok: false` with an artist-facing message.
#[tauri::command]
fn verify_porytiles(app: AppHandle) -> Result<BinaryStatus, String> {
    let path = settings::load(&settings_file(&app)?).effective_porytiles_path();
    Ok(porytiles::verify(&path))
}

/// Compile a tileset with Porytiles into the target decomp project (M11): runs
/// the export -> create/compile -> prefabs loop. Returns success with the
/// written paths, or a mapped Tier 3 problem (raw output kept in `details`).
/// Refuses (Err) only for pre-flight failures: a bad binary, a Tier 1/2 gate, or
/// a filesystem error. The frontend gates the button the same way export is
/// gated, so a Tier 1/2 refusal here is a backstop.
#[tauri::command]
fn compile_tileset(
    app: AppHandle,
    project_path: String,
    tileset_id: String,
    decomp_dir: String,
) -> Result<CompileResult, String> {
    let path = settings::load(&settings_file(&app)?).effective_porytiles_path();
    porytiles::compile_tileset(&project_path, &tileset_id, &decomp_dir, &path)
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
            collision_tags,
            object_problems,
            create_tileset,
            tileset_budget,
            export_tileset,
            get_settings,
            set_porytiles_path,
            verify_porytiles,
            compile_tileset,
            get_recent_projects
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
