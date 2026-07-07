//! PNG artwork loading for the Canvas (Milestone 3).
//!
//! Session-scoped only: we read a PNG the user picks, validate it, and hand its
//! bytes (base64) plus dimensions to the frontend to display. Nothing is copied
//! into the project or written to `project.json` - the Object model (M4) owns
//! artwork persistence. Rust reads the file so the frontend needs no filesystem
//! or asset-protocol plugin.
//!
//! We only need to validate the magic bytes and read the dimensions, not decode
//! pixels, so we parse the PNG header by hand rather than pull in a decoder.
//!
//! Budgeting (Milestone 9) is the exception: predicting palette/tile budgets
//! needs the actual pixels, so `decode_rgba` uses the `png` crate to decode a
//! stored artwork to RGBA8. The header-validation path above stays untouched -
//! it is what import (M4) uses, and it must not depend on a full decode.

use std::fs;
use std::fs::File;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;

/// The 8-byte PNG file signature.
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Reject files larger than this. Artwork for a Pokémon tileset is tiny; a cap
/// keeps a stray multi-hundred-MB PNG from freezing the IPC bridge.
pub const MAX_ARTWORK_BYTES: usize = 20 * 1024 * 1024;

/// A validated PNG ready for the Canvas. `data` is the raw file, base64-encoded,
/// so the frontend can build a `data:image/png;base64,...` URL directly.
#[derive(Debug, Clone, Serialize)]
pub struct Artwork {
    /// File name (no directory), for the Inspector.
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub data: String,
}

/// Errors surfaced to the UI. `Display` produces plain, user-facing strings.
#[derive(Debug, PartialEq, Eq)]
pub enum ArtworkError {
    Io(String),
    TooLarge { bytes: usize, max: usize },
    NotPng,
    Corrupt(String),
}

impl std::fmt::Display for ArtworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArtworkError::Io(msg) => write!(f, "Could not read the image file: {msg}"),
            ArtworkError::TooLarge { bytes, max } => write!(
                f,
                "That image is too large ({} MB). The limit is {} MB.",
                bytes / (1024 * 1024),
                max / (1024 * 1024)
            ),
            ArtworkError::NotPng => write!(f, "That file is not a PNG image."),
            ArtworkError::Corrupt(msg) => write!(f, "That PNG could not be read: {msg}."),
        }
    }
}

/// Validate `bytes` as a PNG within `max` and return its `(width, height)`.
///
/// Pure and `max`-parameterised so the size cap is unit-testable without
/// allocating the full production limit.
fn inspect(bytes: &[u8], max: usize) -> Result<(u32, u32), ArtworkError> {
    if bytes.len() > max {
        return Err(ArtworkError::TooLarge {
            bytes: bytes.len(),
            max,
        });
    }
    // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
    if bytes.len() < 24 {
        return Err(ArtworkError::NotPng);
    }
    if bytes[..8] != PNG_SIGNATURE {
        return Err(ArtworkError::NotPng);
    }
    // The first chunk of a valid PNG is always IHDR.
    if &bytes[12..16] != b"IHDR" {
        return Err(ArtworkError::Corrupt("missing IHDR header".into()));
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 {
        return Err(ArtworkError::Corrupt("zero-sized image".into()));
    }
    Ok((width, height))
}

/// A fully decoded artwork: RGBA8 pixels, row-major, `width * height` long.
/// Used only by the budget path (M9); import never decodes pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedArtwork {
    pub width: u32,
    pub height: u32,
    /// One `[R, G, B, A]` per pixel, row-major (`y * width + x`).
    pub pixels: Vec<[u8; 4]>,
}

/// Decode the PNG at `path` to RGBA8.
///
/// Normalises every input to 8-bit RGBA regardless of the source colour type:
/// `EXPAND` promotes paletted / low-bit grayscale and expands tRNS to alpha,
/// `STRIP_16` narrows 16-bit samples to 8. Whatever channel layout survives
/// (grayscale, grayscale+alpha, RGB, RGBA) is then widened to RGBA per pixel, so
/// the budget maths always sees a uniform buffer.
pub fn decode_rgba(path: &str) -> Result<DecodedArtwork, ArtworkError> {
    let file = File::open(path).map_err(|e| ArtworkError::Io(e.to_string()))?;
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| ArtworkError::Corrupt(e.to_string()))?;

    let size = reader
        .output_buffer_size()
        .ok_or_else(|| ArtworkError::Corrupt("image too large to decode".into()))?;
    let mut buf = vec![0u8; size];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| ArtworkError::Corrupt(e.to_string()))?;

    let (width, height) = (info.width, info.height);
    // `samples` is the channel count of the transformed output (1..=4). Widen
    // each sample group to RGBA: missing colour channels replicate grey, a
    // missing alpha channel is fully opaque.
    let samples = info.color_type.samples();
    let expected = width as usize * height as usize;
    let mut pixels = Vec::with_capacity(expected);
    for chunk in buf[..info.buffer_size()].chunks_exact(samples) {
        let rgba = match samples {
            1 => [chunk[0], chunk[0], chunk[0], 255],
            2 => [chunk[0], chunk[0], chunk[0], chunk[1]],
            3 => [chunk[0], chunk[1], chunk[2], 255],
            _ => [chunk[0], chunk[1], chunk[2], chunk[3]],
        };
        pixels.push(rgba);
    }
    if pixels.len() != expected {
        return Err(ArtworkError::Corrupt("decoded pixel count mismatch".into()));
    }
    Ok(DecodedArtwork {
        width,
        height,
        pixels,
    })
}

/// Read, validate, and encode the PNG at `path`.
pub fn read(path: &str) -> Result<Artwork, ArtworkError> {
    let bytes = fs::read(path).map_err(|e| ArtworkError::Io(e.to_string()))?;
    let (width, height) = inspect(&bytes, MAX_ARTWORK_BYTES)?;
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image.png".to_string());
    Ok(Artwork {
        name,
        width,
        height,
        data: STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal valid PNG head: signature + an IHDR chunk declaring `w`x`h`.
    /// Enough for `inspect`; not a decodable image.
    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes()); // IHDR data length
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.push(8); // bit depth
        bytes
    }

    #[test]
    fn reads_dimensions_from_valid_header() {
        assert_eq!(inspect(&png_header(96, 64), MAX_ARTWORK_BYTES), Ok((96, 64)));
    }

    #[test]
    fn rejects_non_png_magic_bytes() {
        let mut bytes = png_header(16, 16);
        bytes[1] = 0x00; // corrupt the signature
        assert_eq!(inspect(&bytes, MAX_ARTWORK_BYTES), Err(ArtworkError::NotPng));
    }

    #[test]
    fn rejects_files_over_the_cap() {
        // Valid header, but a tiny cap makes it "too large" without a big alloc.
        let bytes = png_header(16, 16);
        let max = 8;
        assert_eq!(
            inspect(&bytes, max),
            Err(ArtworkError::TooLarge {
                bytes: bytes.len(),
                max
            })
        );
    }

    #[test]
    fn rejects_truncated_file() {
        let bytes = PNG_SIGNATURE.to_vec(); // signature only, no IHDR
        assert_eq!(inspect(&bytes, MAX_ARTWORK_BYTES), Err(ArtworkError::NotPng));
    }

    #[test]
    fn rejects_corrupt_ihdr() {
        let mut bytes = png_header(16, 16);
        bytes[12..16].copy_from_slice(b"XXXX"); // wrong chunk type
        assert!(matches!(
            inspect(&bytes, MAX_ARTWORK_BYTES),
            Err(ArtworkError::Corrupt(_))
        ));
    }

    #[test]
    fn rejects_zero_sized_image() {
        assert!(matches!(
            inspect(&png_header(0, 16), MAX_ARTWORK_BYTES),
            Err(ArtworkError::Corrupt(_))
        ));
    }

    /// Encode `pixels` (RGBA, row-major) to a real PNG on disk for decode tests.
    fn write_rgba_png(w: u32, h: u32, pixels: &[[u8; 4]]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("atlas-dec-{}-{n}.png", std::process::id()));
        let file = fs::File::create(&path).unwrap();
        let mut enc = png::Encoder::new(file, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().unwrap();
        let flat: Vec<u8> = pixels.iter().flatten().copied().collect();
        writer.write_image_data(&flat).unwrap();
        writer.finish().unwrap();
        path
    }

    #[test]
    fn decode_rgba_round_trips_pixels() {
        let pixels = [
            [255, 0, 0, 255],
            [0, 255, 0, 128],
            [0, 0, 255, 255],
            [255, 0, 255, 0], // magenta, fully transparent
        ];
        let path = write_rgba_png(2, 2, &pixels);
        let decoded = decode_rgba(path.to_str().unwrap()).unwrap();
        assert_eq!((decoded.width, decoded.height), (2, 2));
        assert_eq!(decoded.pixels, pixels);
    }

    #[test]
    fn decode_widens_rgb_to_opaque_rgba() {
        // An RGB PNG (no alpha) must decode with alpha 255 on every pixel.
        let path = {
            use std::sync::atomic::{AtomicU64, Ordering};
            static N: AtomicU64 = AtomicU64::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let p =
                std::env::temp_dir().join(format!("atlas-rgb-{}-{n}.png", std::process::id()));
            let file = fs::File::create(&p).unwrap();
            let mut enc = png::Encoder::new(file, 1, 2);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().unwrap();
            writer.write_image_data(&[10, 20, 30, 40, 50, 60]).unwrap();
            writer.finish().unwrap();
            p
        };
        let decoded = decode_rgba(path.to_str().unwrap()).unwrap();
        assert_eq!(decoded.pixels, vec![[10, 20, 30, 255], [40, 50, 60, 255]]);
    }
}
