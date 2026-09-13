//! Thumbnail generation.
//!
//! Two paths, cheapest first: an embedded preview JPEG pulled out by exiftool
//! (fast, and the only viable route for HEIC without a HEIF decoder), otherwise
//! a full decode with the `image` crate. Either way the result is a small JPEG
//! returned as a data URL, so the webview never needs filesystem access.

use base64::Engine;
use image::imageops::FilterType;
use image::DynamicImage;
use std::path::Path;

/// Long edge of a generated thumbnail. Comfortably above what any view asks
/// for on a high-DPI display; raising it costs memory on big folders.
const MAX_EDGE: u32 = 384;

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

fn encode_oriented(img: DynamicImage, orientation: u32) -> Option<String> {
    let img = apply_orientation(img.thumbnail(MAX_EDGE, MAX_EDGE), orientation);
    let mut buf = std::io::Cursor::new(Vec::new());
    img.into_rgb8()
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut buf, 78,
        ))
        .ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Some(format!("data:image/jpeg;base64,{b64}"))
}

/// Build a thumbnail data URL for `path`, or `None` if the format cannot be
/// decoded here (the UI falls back to a filename-only tile).
pub fn make(path: &Path, orientation: u32) -> Option<String> {
    if let Some(bytes) = crate::exif::embedded_preview(path) {
        if let Ok(img) = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg) {
            // Embedded previews are stored un-rotated, same as the main image,
            // so the orientation tag applies to them too. Downscale before
            // rotating: transposing a multi-megapixel preview is pure waste.
            return encode_oriented(img, orientation);
        }
    }

    // Full decode. Covers JPEG/PNG/TIFF/WebP; HEIC only reaches here if it had
    // no embedded preview, in which case this fails and we return None.
    let reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let img = reader.decode().ok()?;
    let img = img.resize(MAX_EDGE * 2, MAX_EDGE * 2, FilterType::Triangle);
    encode_oriented(img, orientation)
}
