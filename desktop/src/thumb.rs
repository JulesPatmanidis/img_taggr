//! Thumbnail generation.
//!
//! Decodes with the `image` crate and returns a small JPEG as a data URL, so
//! the webview never needs filesystem access. HEIC has no decoder here and
//! yields `None`, as it does in the browser, and the UI shows a labelled
//! placeholder either way.

use base64::Engine;
use image::imageops::FilterType;
use image::DynamicImage;
use std::path::Path;

/// What an image is being rendered for, which decides its size and quality.
#[derive(Clone, Copy)]
pub enum Size {
    /// Cards, pins and chips.
    Thumb,
    /// The full-screen lightbox.
    Preview,
}

impl Size {
    /// Long edge in pixels.
    fn edge(self) -> u32 {
        match self {
            // Must match THUMB_EDGE in app/backend.js, which is what the web
            // build renders to. Comfortably above what any view asks for on a
            // high-DPI display; raising it costs memory on big folders.
            Size::Thumb => 384,
            // Sharp on a large display, and still quick to hand to the webview
            // as a data URL.
            Size::Preview => 2048,
        }
    }

    fn jpeg_quality(self) -> u8 {
        match self {
            Size::Thumb => 78,
            // Artefacts that vanish in a thumbnail show up at full-screen size.
            Size::Preview => 85,
        }
    }
}

/// Undo the camera's EXIF orientation so the thumbnail is upright.
fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn encode_oriented(img: DynamicImage, orientation: u32, size: Size) -> Option<String> {
    let edge = size.edge();
    let img = apply_orientation(img.thumbnail(edge, edge), orientation);
    let quality = size.jpeg_quality();
    let mut buf = std::io::Cursor::new(Vec::new());
    img.into_rgb8()
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut buf, quality,
        ))
        .ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Some(format!("data:image/jpeg;base64,{b64}"))
}

/// Build a JPEG data URL for `path` at `size`, or `None` if the format cannot
/// be decoded here (the UI falls back to a filename-only tile).
pub fn make(path: &Path, orientation: u32, size: Size) -> Option<String> {
    // Covers JPEG/PNG/TIFF/WebP. HEIC fails here and returns None.
    let reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let img = reader.decode().ok()?;
    // A cheap pre-shrink before the slow, sharp resampler; only worth it when
    // the target is far below the camera's resolution.
    let img = match size {
        Size::Thumb => img.resize(size.edge() * 2, size.edge() * 2, FilterType::Triangle),
        Size::Preview => img,
    };
    encode_oriented(img, orientation, size)
}
