import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

// Mirrors the serde structs in crates/atlas/src/project.rs. Rust owns the
// schema; these types just describe what crosses the IPC boundary.
export type Project = {
  format_version: number;
  name: string;
  created: number;
  modified: number;
};

export type OpenProject = {
  path: string;
  project: Project;
};

export type Recent = {
  path: string;
  name: string;
};

// A validated PNG read for the Canvas. `data` is base64 of the raw file;
// build a `data:image/png;base64,${data}` URL to display it. Session-scoped:
// nothing is persisted (Objects, M4, own artwork).
export type Artwork = {
  name: string;
  width: number;
  height: number;
  data: string;
};

/// Reads the crate version from the Rust side. Proves the IPC bridge works.
export async function getAppVersion(): Promise<string> {
  return invoke<string>('app_version');
}

/// Create `<location>/<name>` on disk and open it.
export async function createProject(
  location: string,
  name: string,
): Promise<OpenProject> {
  return invoke<OpenProject>('create_project', { location, name });
}

/// Open an existing project directory.
export async function openProject(dir: string): Promise<OpenProject> {
  return invoke<OpenProject>('open_project', { dir });
}

/// Persist project state; returns it with a refreshed `modified` timestamp.
export async function saveProject(
  path: string,
  project: Project,
): Promise<Project> {
  return invoke<Project>('save_project', { path, project });
}

/// Recent projects, most-recent-first, with dead paths already pruned.
export async function getRecentProjects(): Promise<Recent[]> {
  return invoke<Recent[]>('get_recent_projects');
}

/// Native directory picker. Returns null if the user cancels.
export async function pickDirectory(title: string): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, title });
  return typeof result === 'string' ? result : null;
}

/// Native PNG file picker. Returns null if the user cancels.
export async function pickPngFile(): Promise<string | null> {
  const result = await openDialog({
    multiple: false,
    title: 'Import PNG artwork',
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  return typeof result === 'string' ? result : null;
}

/// Read, validate, and load a PNG through Rust (no fs plugin needed).
export async function readArtwork(path: string): Promise<Artwork> {
  return invoke<Artwork>('read_artwork', { path });
}
