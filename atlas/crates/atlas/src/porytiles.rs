//! Porytiles invocation and Tier 3 diagnostic mapping (Milestone 11).
//!
//! This module closes the export loop: it drives the real Porytiles compiler
//! (pinned 1.0.0) over the M10 exporter's output and turns every toolchain
//! outcome into an artist-facing Tier 3 diagnostic. It is pokemon_emerald
//! territory - the only place in the crate that shells out to the toolchain.
//!
//! ## Workflow (verified in `spikes/spike0/FINDINGS.md`, "Working command sequence")
//!
//! A secondary tileset cannot compile standalone; it needs a Porytiles-managed
//! partner primary, and the pairing flags are NOT persisted - they must be
//! repeated on every `compile-tileset`. So each compile:
//!
//! 1. `create-tileset gTileset_PorygonPrimary` (once; skipped if already managed)
//! 2. `create-tileset <secondary> --secondary --primary-pairing-mode manual
//!    --primary-pairing-partners gTileset_PorygonPrimary` (once)
//! 3. write the M10 source (bottom/middle/top/attributes.csv) into the managed
//!    secondary's `porytiles_src/`
//! 4. `compile-tileset <secondary> --primary-pairing-mode manual
//!    --primary-pairing-partners gTileset_PorygonPrimary`
//!
//! All four run with `-C <decomp>` and are spawned via `std::process::Command`
//! with stdout/stderr captured. Porytiles PANICS (SIGABRT, exit 134) when the
//! palette budget is exceeded (FINDINGS finding 3), so the call is treated as
//! crash-tolerant: an abnormal exit is caught and mapped to a diagnostic, never
//! allowed to hang or take down Atlas.
//!
//! ## Tier 3 mapping (compiler.md "Tier 3", bible: raw output never reaches the artist)
//!
//! `classify` matches the greppable `[tag]` blocks and `root cause` phrases the
//! error surface catalog documents (FINDINGS "Error surface catalog") plus the
//! panic signature, and `artist_message` gives each class a plain, located-as-
//! possible message. The raw compiler output is preserved in `CompileResult.
//! details` for bug reports but is never the primary message. Every Tier 3
//! occurrence is a gap in Tier 2 prediction; the palette panic in particular is
//! reported honestly as a Porygon bug (compiler.md: "treat SIGABRT as a Tier 2
//! prediction bug, log it, and show the palette-budget message").

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::exporter;
use crate::prefabs::{self, PrefabResult};
use crate::validity::{Problem, Tier};

/// The only Porytiles version Atlas supports (compiler.md version-pinning policy;
/// Spike 0 ran 1.0.0). Anything else is refused rather than trusted.
pub const PINNED_VERSION: &str = "1.0.0";

/// The managed partner primary every Atlas secondary pairs with. Atlas owns it;
/// it is created once per decomp project and reused across compiles. (MVP note:
/// its palettes could extend secondary capacity - deferred, see the report.)
const PRIMARY_SYMBOL: &str = "gTileset_PorygonPrimary";

/// Result of checking the Porytiles binary, for the UI's compile-readiness state.
#[derive(Debug, Clone, Serialize)]
pub struct BinaryStatus {
    /// True only when the binary runs and reports exactly the pinned version.
    pub ok: bool,
    pub path: String,
    /// The full version line Porytiles printed, if it ran at all.
    pub version: Option<String>,
    /// Artist-facing status message (never raw toolchain jargon).
    pub message: String,
}

/// The outcome of a compile, returned to the UI. On success `problems` is empty
/// and the written paths are populated; on a toolchain failure `problems` holds
/// the mapped Tier 3 diagnostics and `details` carries the raw report.
#[derive(Debug, Clone, Serialize)]
pub struct CompileResult {
    pub success: bool,
    pub primary_symbol: String,
    pub secondary_symbol: String,
    /// Where the Porymap-ready binaries landed (on success).
    pub tileset_bin_dir: Option<String>,
    /// Prefab emission result (on success).
    pub prefabs: Option<PrefabResult>,
    /// Tier 3 problems in artist terms (empty on success).
    pub problems: Vec<Problem>,
    /// Raw compiler output for a bug report. Shown only in a details/expander,
    /// never as the primary message (bible rule).
    pub details: Option<String>,
}

/// The class of a Porytiles failure, resolved from its output and exit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureClass {
    /// Palette budget exceeded: Porytiles PANICS (SIGABRT / exit 134). The one
    /// case that is a crash, not a clean diagnostic.
    PaletteOverflowPanic,
    /// Three depth planes in one 16x16 cell (`[layer-mode-violation]`).
    LayerMode,
    /// More than 15 colours in one 8x8 tile (`[tile-color-count-violation]`).
    TileColorCount,
    /// An `MB_*` behavior name Porytiles does not know.
    UnknownBehavior,
    /// Artwork dimensions not a multiple of 8 (Porytiles' tile-size rule).
    ImageDimensions,
    /// A clean failure Atlas does not recognise: honest fallback.
    Unknown,
}

/// Run `<path> --version` and decide whether it is the pinned Porytiles. Never
/// panics: a missing binary or a version mismatch becomes a polite `ok: false`.
pub fn verify(path: &str) -> BinaryStatus {
    let output = Command::new(path).arg("--version").output();
    match output {
        Err(_) => BinaryStatus {
            ok: false,
            path: path.to_string(),
            version: None,
            message: format!(
                "Porytiles was not found at {path}. Install Porytiles {PINNED_VERSION}, or set \
                 the path in Compile settings."
            ),
        },
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            let line = text.lines().next().unwrap_or("").trim();
            let reported = parse_version(line);
            match reported {
                Some(v) if v == PINNED_VERSION => BinaryStatus {
                    ok: true,
                    path: path.to_string(),
                    version: Some(line.to_string()),
                    message: format!("Porytiles {PINNED_VERSION} is ready."),
                },
                Some(v) => BinaryStatus {
                    ok: false,
                    path: path.to_string(),
                    version: Some(line.to_string()),
                    message: format!(
                        "Porygon needs Porytiles {PINNED_VERSION} but found {v} at {path}. \
                         Compiling is disabled until the pinned version is installed."
                    ),
                },
                None => BinaryStatus {
                    ok: false,
                    path: path.to_string(),
                    version: None,
                    message: format!(
                        "The program at {path} did not report a Porytiles version. Point Porygon \
                         at Porytiles {PINNED_VERSION}."
                    ),
                },
            }
        }
    }
}

/// Extract the version token from a `porytiles --version` line such as
/// `porytiles 1.0.0 2026.06.05T...`. Returns the second whitespace token.
fn parse_version(line: &str) -> Option<String> {
    let mut parts = line.split_whitespace();
    let first = parts.next()?;
    if !first.eq_ignore_ascii_case("porytiles") {
        return None;
    }
    parts.next().map(|s| s.to_string())
}

/// Captured result of one Porytiles subprocess, decoupled from `Command` so the
/// classification is pure and testable.
struct RunOutput {
    /// Exit code, or `None` if the process was terminated by a signal.
    code: Option<i32>,
    /// True if a signal (e.g. SIGABRT from the palette panic) killed it.
    killed_by_signal: bool,
    combined: String,
}

impl RunOutput {
    fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// Spawn one Porytiles subcommand, capturing stdout+stderr and surviving an
/// abnormal exit (the palette panic). Never propagates a crash.
fn run(porytiles: &str, args: &[&str], project_dir: &str) -> Result<RunOutput, String> {
    let out = Command::new(porytiles)
        .args(args)
        .arg("-C")
        .arg(project_dir)
        .output()
        .map_err(|e| {
            format!(
                "Could not run Porytiles at {porytiles}: {e}. Check the path in Compile settings."
            )
        })?;

    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&out.stderr));

    Ok(RunOutput {
        code: out.status.code(),
        killed_by_signal: signal_of(&out.status).is_some(),
        combined,
    })
}

/// The signal that terminated a process, if any. On Unix this reads the real
/// signal (SIGABRT for the palette panic); elsewhere it is always `None`. Kept
/// as a safe wrapper so the crate's `forbid(unsafe_code)` stays intact.
#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// True when the tileset symbol already has a Porytiles management directory
/// (its manifest), i.e. it was created on a previous compile. `create-tileset`
/// is not idempotent, so Atlas skips it when the tileset is already managed.
fn is_managed(project_dir: &str, symbol: &str) -> bool {
    Path::new(project_dir)
        .join("porytiles")
        .join("tilesets")
        .join(symbol)
        .join("tileset-manifest.json")
        .is_file()
}

/// Compile a tileset end to end: verify the binary, register the managed
/// primary/secondary if needed, write the M10 source, run `compile-tileset`
/// crash-tolerantly, and on success emit Porymap prefabs.
///
/// Returns `Err` only for pre-flight failures (bad binary, Tier 1/2 gate,
/// filesystem). A toolchain rejection is `Ok(CompileResult { success: false })`
/// carrying the mapped Tier 3 problems - the loop ran, it just said no.
pub fn compile_tileset(
    project_dir: &str,
    tileset_id: &str,
    decomp_dir: &str,
    porytiles_path: &str,
) -> Result<CompileResult, String> {
    // Pre-flight: the binary must be the pinned version.
    let status = verify(porytiles_path);
    if !status.ok {
        return Err(status.message);
    }
    if !Path::new(decomp_dir).is_dir() {
        return Err("The target decomp project folder does not exist.".to_string());
    }

    // Backstop gate: the UI blocks compile while Tier 1/2 problems exist, but
    // never let unpredicted-safe input reach the crash-prone compiler.
    let (tileset, members) = crate::budgets::load_members(project_dir, tileset_id)?;
    exporter::gate(&members)?;
    let (bundle, compiled) = exporter::compose(&tileset.name, &members)?;

    let secondary_symbol = exporter::symbolize(&tileset.name);
    let secondary_slug = exporter::slugify(&tileset.name, "tileset");

    // 1. Managed partner primary (once).
    if !is_managed(decomp_dir, PRIMARY_SYMBOL) {
        let out = run(porytiles_path, &["create-tileset", PRIMARY_SYMBOL], decomp_dir)?;
        if !out.success() {
            return Err(format!(
                "Porygon could not set up the partner primary tileset. Details:\n{}",
                out.combined
            ));
        }
    }

    // 2. Managed secondary paired to the primary (once).
    if !is_managed(decomp_dir, &secondary_symbol) {
        let out = run(
            porytiles_path,
            &[
                "create-tileset",
                &secondary_symbol,
                "--secondary",
                "--primary-pairing-mode",
                "manual",
                "--primary-pairing-partners",
                PRIMARY_SYMBOL,
            ],
            decomp_dir,
        )?;
        if !out.success() {
            return Err(format!(
                "Porygon could not create the tileset \"{}\" in the project. Details:\n{}",
                tileset.name, out.combined
            ));
        }
    }

    // 3. Write the M10 source into the managed secondary's porytiles_src.
    let src_dir = Path::new(decomp_dir)
        .join("data")
        .join("tilesets")
        .join("secondary")
        .join(&secondary_slug)
        .join("porytiles_src");
    exporter::write_source_layers(&src_dir, &bundle)?;

    // 4. Compile (pairing flags repeated - they are not persisted). Crash-tolerant.
    let out = run(
        porytiles_path,
        &[
            "compile-tileset",
            &secondary_symbol,
            "--primary-pairing-mode",
            "manual",
            "--primary-pairing-partners",
            PRIMARY_SYMBOL,
        ],
        decomp_dir,
    )?;

    if !out.success() {
        let class = classify(&out.combined, out.code, out.killed_by_signal);
        return Ok(CompileResult {
            success: false,
            primary_symbol: PRIMARY_SYMBOL.to_string(),
            secondary_symbol,
            tileset_bin_dir: None,
            prefabs: None,
            problems: vec![Problem {
                tier: Tier::Export,
                message: artist_message(class),
            }],
            details: Some(out.combined),
        });
    }

    // Success: emit prefabs and report where everything landed.
    let prefabs = prefabs::emit_prefabs(decomp_dir, &secondary_symbol, &compiled)?;
    let bin_dir = Path::new(decomp_dir)
        .join("data")
        .join("tilesets")
        .join("secondary")
        .join(&secondary_slug)
        .join("porytiles_bin");

    Ok(CompileResult {
        success: true,
        primary_symbol: PRIMARY_SYMBOL.to_string(),
        secondary_symbol,
        tileset_bin_dir: Some(bin_dir.to_string_lossy().into_owned()),
        prefabs: Some(prefabs),
        problems: Vec::new(),
        details: Some(out.combined),
    })
}

/// Classify a failed Porytiles run from its output and exit status. The palette
/// panic is checked first because it is the crash case (signal / exit 134 /
/// the count-limit assertion); the rest key off the documented `[tag]` blocks
/// and root-cause phrases.
fn classify(combined: &str, code: Option<i32>, killed_by_signal: bool) -> FailureClass {
    let panicked = killed_by_signal
        || code == Some(134)
        || combined.contains("color_index_map.size() > count_limit")
        || combined.contains("pipeline_step_validate_input")
        || combined.contains("|             PANIC             |");
    if panicked {
        return FailureClass::PaletteOverflowPanic;
    }
    if combined.contains("[layer-mode-violation]")
        || combined.contains("mismatched implied layer mode")
    {
        return FailureClass::LayerMode;
    }
    if combined.contains("[tile-color-count-violation]")
        || combined.contains("more than 15 unique non-transparent")
    {
        return FailureClass::TileColorCount;
    }
    if combined.contains("unknown metatile behavior") {
        return FailureClass::UnknownBehavior;
    }
    if combined.contains("image dimensions must be a multiple of") {
        return FailureClass::ImageDimensions;
    }
    FailureClass::Unknown
}

/// The artist-facing Tier 3 message for a failure class. Never raw toolchain
/// jargon; wording mirrors compiler.md's Tier 2/3 tables so the same problem
/// reads consistently wherever it surfaces.
fn artist_message(class: FailureClass) -> String {
    match class {
        FailureClass::PaletteOverflowPanic =>
            "The compiler ran out of colour palettes and stopped while building this tileset. \
             Porygon should have caught this before compiling - please report it. To finish now, \
             remove an object or align colours so objects share palettes."
                .to_string(),
        FailureClass::LayerMode =>
            "This tileset needs the player both in front of and behind things in one 16x16 area. \
             Simplify the overlap there."
                .to_string(),
        FailureClass::TileColorCount =>
            "A small 8x8 area in this tileset uses more than the 15 colours Pokemon Emerald allows \
             per tile. Reduce the colours there."
                .to_string(),
        FailureClass::UnknownBehavior =>
            "A collision tag on one of these objects is not recognised by this game version. \
             Re-paint that collision cell."
                .to_string(),
        FailureClass::ImageDimensions =>
            "Some artwork does not line up with the tile grid. Fix the object's size on the Canvas \
             so each dimension is a multiple of 16px."
                .to_string(),
        FailureClass::Unknown =>
            "Porytiles could not compile this tileset. Open the details below for the compiler's \
             report and share it in a bug report."
                .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/porytiles")
            .join(format!("{name}.stderr.txt"));
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()))
    }

    #[test]
    fn parse_version_reads_the_pinned_line() {
        assert_eq!(
            parse_version("porytiles 1.0.0 2026.06.05T16:34:30+00:00").as_deref(),
            Some("1.0.0")
        );
        assert_eq!(parse_version("porytiles").as_deref(), None);
        assert_eq!(parse_version("something else 1.0.0").as_deref(), None);
    }

    #[test]
    fn classify_palette_panic_from_exit_134() {
        let text = fixture("palbudget");
        // The real crash exits 134 (or is killed by SIGABRT); both must map here.
        assert_eq!(
            classify(&text, Some(134), false),
            FailureClass::PaletteOverflowPanic
        );
        assert_eq!(classify(&text, None, true), FailureClass::PaletteOverflowPanic);
        // Even with a clean-looking exit code, the assertion text betrays it.
        assert_eq!(
            classify(&text, Some(1), false),
            FailureClass::PaletteOverflowPanic
        );
    }

    #[test]
    fn classify_clean_errors_from_tags_and_root_causes() {
        assert_eq!(classify(&fixture("triple"), Some(1), false), FailureClass::LayerMode);
        assert_eq!(
            classify(&fixture("toomanycolors"), Some(1), false),
            FailureClass::TileColorCount
        );
        assert_eq!(
            classify(&fixture("unknown_behavior"), Some(1), false),
            FailureClass::UnknownBehavior
        );
        assert_eq!(
            classify(&fixture("baddims"), Some(1), false),
            FailureClass::ImageDimensions
        );
    }

    #[test]
    fn unrecognised_failure_falls_back_to_unknown() {
        assert_eq!(
            classify("some novel error we have never seen", Some(1), false),
            FailureClass::Unknown
        );
    }

    #[test]
    fn every_class_has_a_jargon_free_message() {
        for class in [
            FailureClass::PaletteOverflowPanic,
            FailureClass::LayerMode,
            FailureClass::TileColorCount,
            FailureClass::UnknownBehavior,
            FailureClass::ImageDimensions,
            FailureClass::Unknown,
        ] {
            let m = artist_message(class);
            assert!(!m.is_empty());
            // No raw compiler tokens leak into the artist message.
            for jargon in ["porytiles_src", "metatile_behaviors.h", "color_index_map", "[layer"] {
                assert!(!m.contains(jargon), "message leaked jargon {jargon:?}: {m}");
            }
        }
    }

    #[test]
    fn palette_message_is_honest_about_being_our_bug() {
        // compiler.md: SIGABRT is a Tier 2 prediction bug - own it and ask for a report.
        let m = artist_message(FailureClass::PaletteOverflowPanic);
        assert!(m.contains("please report it"), "got: {m}");
    }

    #[test]
    fn verify_rejects_a_missing_binary() {
        let s = verify("/nonexistent/porytiles-xyz");
        assert!(!s.ok);
        assert!(s.version.is_none());
        assert!(s.message.contains("not found"));
    }

    // --- End-to-end against the real binary -----------------------------------
    //
    // Runs only when the pinned Porytiles is installed at the default path, so
    // CI without Porytiles is a clean no-op and there is nothing to gate manually.
    // Builds a *synthetic* decomp scaffold in a temp dir (never the real
    // pokeemerald-expansion checkout) with just the pieces FINDINGS says Porytiles
    // needs, then compiles a one-object tileset and asserts the binaries and
    // prefabs land. To force it in CI, install Porytiles 1.0.0 at the default path.

    fn build_scaffold(dir: &Path) {
        use std::fs;
        fs::create_dir_all(dir.join("include/constants")).unwrap();
        fs::create_dir_all(dir.join("src/data/tilesets")).unwrap();
        fs::write(
            dir.join("include/fieldmap.h"),
            r#"#define NUM_TILES_IN_PRIMARY 512
#define NUM_METATILES_IN_PRIMARY 512
#define NUM_PALS_IN_PRIMARY 6
#define NUM_METATILES_TOTAL 1024
#define NUM_TILES_TOTAL 1024
#define NUM_PALS_TOTAL 13
#define MAX_MAP_DATA_SIZE 10240
#define NUM_TILES_PER_METATILE 8
"#,
        )
        .unwrap();
        // Minimal global.fieldmap.h: base-game detection markers + the layer and
        // attribute enums Porytiles reads (verified sufficient during M11 spike work).
        fs::write(
            dir.join("include/global.fieldmap.h"),
            r#"#define METATILE_ATTR_BEHAVIOR_MASK 0x00FF
#define METATILE_ATTR_LAYER_MASK    0xF000
#define METATILE_ATTR_BEHAVIOR_SHIFT 0
#define METATILE_ATTR_LAYER_SHIFT   12
enum {
    METATILE_LAYER_TYPE_NORMAL,
    METATILE_LAYER_TYPE_COVERED,
    METATILE_LAYER_TYPE_SPLIT,
};
enum {
    METATILE_ATTRIBUTE_BEHAVIOR,
    METATILE_ATTRIBUTE_TERRAIN,
    METATILE_ATTRIBUTE_2,
    METATILE_ATTRIBUTE_3,
    METATILE_ATTRIBUTE_ENCOUNTER_TYPE,
    METATILE_ATTRIBUTE_5,
    METATILE_ATTRIBUTE_LAYER_TYPE,
    METATILE_ATTRIBUTE_7,
    METATILE_ATTRIBUTE_COUNT,
    METATILE_ATTRIBUTES_ALL = 255
};
"#,
        )
        .unwrap();
        // Behavior names Atlas can emit (unique values; MB_TALL_GRASS used below).
        fs::write(
            dir.join("include/constants/metatile_behaviors.h"),
            r#"#define MB_NORMAL 0x00
#define MB_TALL_GRASS 0x02
#define MB_LONG_GRASS 0x03
#define MB_POND_WATER 0x14
#define MB_DEEP_WATER 0x15
#define MB_OCEAN_WATER 0x18
#define MB_WATERFALL 0x1A
#define MB_PUDDLE 0x16
#define MB_ICE 0x20
#define MB_SAND 0x17
#define MB_JUMP_NORTH 0x38
#define MB_JUMP_SOUTH 0x39
#define MB_JUMP_EAST 0x3A
#define MB_JUMP_WEST 0x3B
"#,
        )
        .unwrap();
        fs::write(dir.join("src/data/tilesets/headers.h"), "#include \"fieldmap.h\"\n").unwrap();
        fs::write(dir.join("src/data/tilesets/graphics.h"), "\n").unwrap();
        fs::write(dir.join("src/data/tilesets/metatiles.h"), "\n").unwrap();
        fs::write(
            dir.join("include/tileset_anims.h"),
            "#ifndef GUARD_TILESET_ANIMS_H\n#define GUARD_TILESET_ANIMS_H\n\
             void InitTilesetAnimations(void);\n#endif\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/tileset_anims.c"),
            "#include \"tileset_anims.h\"\nvoid InitTilesetAnimations(void) {}\n",
        )
        .unwrap();
    }

    /// Build a real Atlas project on disk with one 16x16 object in one tileset.
    fn atlas_project(root: &Path) -> (PathBuf, String) {
        use std::fs;
        let loc = root.join("atlas_projects");
        fs::create_dir_all(&loc).unwrap();
        let open = crate::project::create(loc.to_str().unwrap(), "Forest Spike").unwrap();
        let project_dir = PathBuf::from(&open.path);
        let mut project = open.project;

        let obj = crate::object::Object::for_test("Grass", 16, 16);
        // Write a solid green artwork PNG.
        let dir = project_dir
            .join(crate::object::OBJECTS_DIR)
            .join(&obj.id);
        fs::create_dir_all(&dir).unwrap();
        let file = fs::File::create(dir.join(crate::object::ARTWORK_FILE)).unwrap();
        let mut enc = png::Encoder::new(file, 16, 16);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().unwrap();
        let px: Vec<u8> = [[40u8, 160, 72, 255]; 256].iter().flatten().copied().collect();
        w.write_image_data(&px).unwrap();
        w.finish().unwrap();

        let mut tileset = crate::tileset::Tileset::new("Forest Spike");
        tileset.members.push(obj.id.clone());
        let tileset_id = tileset.id.clone();
        // Tag cell 0 so attributes.csv exercises a real MB_* behavior end to end.
        let mut obj = obj;
        obj.collision.cells.insert(
            0,
            crate::collision::CollisionValue::Custom("tall_grass".to_string()),
        );
        project.objects.push(obj);
        project.tilesets.push(tileset);
        crate::project::save(open.path.as_str(), project).unwrap();
        (project_dir, tileset_id)
    }

    #[test]
    fn end_to_end_compile_against_real_porytiles() {
        let porytiles = crate::settings::DEFAULT_PORYTILES_PATH;
        if !verify(porytiles).ok {
            eprintln!("skipping E2E: pinned Porytiles not installed at {porytiles}");
            return;
        }
        use std::fs;
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("atlas-e2e-{}-{n}", std::process::id()));
        let decomp = root.join("decomp");
        fs::create_dir_all(&decomp).unwrap();
        build_scaffold(&decomp);
        let (project_dir, tileset_id) = atlas_project(&root);

        let result = compile_tileset(
            project_dir.to_str().unwrap(),
            &tileset_id,
            decomp.to_str().unwrap(),
            porytiles,
        )
        .expect("compile should not hard-fail");

        assert!(result.success, "compile failed: {:?}", result.problems);
        assert_eq!(result.secondary_symbol, "gTileset_ForestSpike");
        // The Porymap-ready binaries landed.
        let bin = decomp.join("data/tilesets/secondary/forest_spike/porytiles_bin/metatiles.bin");
        assert!(bin.is_file(), "metatiles.bin missing at {}", bin.display());
        // Prefabs were written and wired.
        let prefabs = decomp.join("prefabs.json");
        assert!(prefabs.is_file());
        let arr: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&prefabs).unwrap()).unwrap();
        assert_eq!(arr[0]["secondary_tileset"], "gTileset_ForestSpike");
        assert_eq!(arr[0]["metatiles"][0]["metatile_id"], 512);
        let cfg = fs::read_to_string(decomp.join("porymap.project.cfg")).unwrap();
        assert!(cfg.contains("prefabs_filepath=prefabs.json"));

        // Re-compile: the managed tileset already exists, so this exercises the
        // idempotent skip path and must still succeed.
        let again = compile_tileset(
            project_dir.to_str().unwrap(),
            &tileset_id,
            decomp.to_str().unwrap(),
            porytiles,
        )
        .expect("re-compile should not hard-fail");
        assert!(again.success, "re-compile failed: {:?}", again.problems);

        let _ = fs::remove_dir_all(&root);
    }
}
