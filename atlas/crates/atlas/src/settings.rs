//! App-level settings, persisted as JSON in the app config dir (Milestone 11,
//! extended in Milestone 14 into the Preferences dialog's backing store).
//!
//! Settings are app-scoped rather than per-project (like `recents.json`): a
//! machine has one Porytiles install, and the editor preferences (autosave
//! pacing, default grid visibility) are the artist's, not the project's.
//! `load`/`save` name their I/O; a missing or corrupt file loads as defaults so
//! a first run just works. `#[serde(default)]` on the struct means a settings
//! file written by an older build (missing the newer fields) still loads, with
//! the absent fields taking their `Default` values.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Default Porytiles binary location (the pinned Homebrew install path). The
/// milestone fixes this default; `porytiles_path` overrides it when set.
pub const DEFAULT_PORYTILES_PATH: &str = "/opt/homebrew/bin/porytiles";

/// Default autosave debounce, matching the value the store shipped with before
/// it became configurable.
pub const DEFAULT_AUTOSAVE_DEBOUNCE_MS: u64 = 1000;

/// Bounds for the autosave debounce, so a hand-edited settings file (or a UI
/// bug) can never disable saving outright or hammer the disk.
pub const MIN_AUTOSAVE_DEBOUNCE_MS: u64 = 250;
pub const MAX_AUTOSAVE_DEBOUNCE_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Override for the Porytiles binary. `None` means use the default path.
    pub porytiles_path: Option<String>,
    /// How long the editor waits after an edit before autosaving, in ms.
    pub autosave_debounce_ms: u64,
    /// Whether the 16px metatile grid is shown by default on the canvas.
    pub default_grid: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            porytiles_path: None,
            autosave_debounce_ms: DEFAULT_AUTOSAVE_DEBOUNCE_MS,
            default_grid: false,
        }
    }
}

impl Settings {
    /// The effective Porytiles path: the override if set, else the default.
    pub fn effective_porytiles_path(&self) -> String {
        self.porytiles_path
            .clone()
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_PORYTILES_PATH.to_string())
    }

    /// Normalize before persisting: blank paths clear back to the default, and
    /// the debounce is clamped to a sane range.
    pub fn normalized(mut self) -> Self {
        self.porytiles_path = self.porytiles_path.filter(|p| !p.trim().is_empty());
        self.autosave_debounce_ms = self
            .autosave_debounce_ms
            .clamp(MIN_AUTOSAVE_DEBOUNCE_MS, MAX_AUTOSAVE_DEBOUNCE_MS);
        self
    }
}

/// Load settings, treating a missing or corrupt file as defaults.
pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist settings, creating the config directory if needed.
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_path_is_used_when_unset() {
        assert_eq!(
            Settings::default().effective_porytiles_path(),
            DEFAULT_PORYTILES_PATH
        );
    }

    #[test]
    fn override_takes_precedence_when_non_empty() {
        let s = Settings {
            porytiles_path: Some("/custom/porytiles".to_string()),
            ..Default::default()
        };
        assert_eq!(s.effective_porytiles_path(), "/custom/porytiles");
    }

    #[test]
    fn blank_override_falls_back_to_default() {
        let s = Settings {
            porytiles_path: Some("   ".to_string()),
            ..Default::default()
        };
        assert_eq!(s.effective_porytiles_path(), DEFAULT_PORYTILES_PATH);
    }

    #[test]
    fn default_autosave_matches_legacy_value() {
        assert_eq!(
            Settings::default().autosave_debounce_ms,
            DEFAULT_AUTOSAVE_DEBOUNCE_MS
        );
    }

    #[test]
    fn normalize_clamps_debounce_and_blanks_path() {
        let s = Settings {
            porytiles_path: Some("  ".to_string()),
            autosave_debounce_ms: 10,
            default_grid: true,
        }
        .normalized();
        assert_eq!(s.porytiles_path, None);
        assert_eq!(s.autosave_debounce_ms, MIN_AUTOSAVE_DEBOUNCE_MS);
        assert!(s.default_grid);
    }

    #[test]
    fn missing_file_loads_defaults() {
        let p = std::env::temp_dir().join("atlas-settings-missing-xyz.json");
        let _ = fs::remove_file(&p);
        assert_eq!(load(&p), Settings::default());
    }

    #[test]
    fn partial_json_fills_missing_fields_with_defaults() {
        // A settings file written before autosave/grid existed still loads.
        let p =
            std::env::temp_dir().join(format!("atlas-settings-partial-{}.json", std::process::id()));
        fs::write(&p, r#"{"porytiles_path":"/opt/porytiles"}"#).unwrap();
        let loaded = load(&p);
        assert_eq!(loaded.porytiles_path.as_deref(), Some("/opt/porytiles"));
        assert_eq!(loaded.autosave_debounce_ms, DEFAULT_AUTOSAVE_DEBOUNCE_MS);
        assert!(!loaded.default_grid);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn save_then_load_round_trips() {
        let p = std::env::temp_dir().join(format!("atlas-settings-{}.json", std::process::id()));
        let s = Settings {
            porytiles_path: Some("/opt/porytiles".to_string()),
            autosave_debounce_ms: 2000,
            default_grid: true,
        };
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
        let _ = fs::remove_file(&p);
    }
}
