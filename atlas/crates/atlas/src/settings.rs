//! App-level settings, persisted as JSON in the app config dir (Milestone 11).
//!
//! The only setting today is the Porytiles binary path. It is app-scoped rather
//! than per-project (like `recents.json`): a machine has one Porytiles install,
//! and every project compiles through it. `load`/`save` name their I/O; a
//! missing or corrupt file loads as defaults so a first run just works.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Default Porytiles binary location (the pinned Homebrew install path). The
/// milestone fixes this default; `porytiles_path` overrides it when set.
pub const DEFAULT_PORYTILES_PATH: &str = "/opt/homebrew/bin/porytiles";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Override for the Porytiles binary. `None` means use the default path.
    #[serde(default)]
    pub porytiles_path: Option<String>,
}

impl Settings {
    /// The effective Porytiles path: the override if set, else the default.
    pub fn effective_porytiles_path(&self) -> String {
        self.porytiles_path
            .clone()
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_PORYTILES_PATH.to_string())
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
        };
        assert_eq!(s.effective_porytiles_path(), "/custom/porytiles");
    }

    #[test]
    fn blank_override_falls_back_to_default() {
        let s = Settings {
            porytiles_path: Some("   ".to_string()),
        };
        assert_eq!(s.effective_porytiles_path(), DEFAULT_PORYTILES_PATH);
    }

    #[test]
    fn missing_file_loads_defaults() {
        let p = std::env::temp_dir().join("atlas-settings-missing-xyz.json");
        let _ = fs::remove_file(&p);
        assert_eq!(load(&p), Settings::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let p = std::env::temp_dir().join(format!("atlas-settings-{}.json", std::process::id()));
        let s = Settings {
            porytiles_path: Some("/opt/porytiles".to_string()),
        };
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
        let _ = fs::remove_file(&p);
    }
}
