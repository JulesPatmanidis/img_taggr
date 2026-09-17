//! The metadata engine, the one implementation behind both targets.
//!
//! The desktop app and the browser build share this crate, so "save" cannot
//! mean two different things: there is one tag list, one format-detection rule
//! and one set of tests covering both.
//!
//! Everything is in-memory. A browser has no filesystem, so files arrive as
//! byte slices and leave as byte vectors; the desktop reads and writes the
//! files around that boundary.

use little_exif::exif_tag::ExifTag;
use little_exif::filetype::FileExtension;
use std::io::Cursor;
use little_exif::metadata::Metadata;
use little_exif::rational::uR64;

/// Formats this engine can write. Lossy WebP is absent deliberately:
/// little_exif cannot convert a simple-format VP8 chunk to the extended form
/// that carries EXIF, so such files are rejected rather than silently mangled.
pub const WRITABLE: &[&str] = &["jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif"];

pub fn ext_of(filename: &str) -> String {
    filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn type_from_ext(filename: &str) -> Option<FileExtension> {
    match ext_of(filename).as_str() {
        "jpg" | "jpeg" => Some(FileExtension::JPEG),
        // zTXt keeps the EXIF chunk compressed, which is what other tools expect.
        "png" => Some(FileExtension::PNG { as_zTXt_chunk: true }),
        "tif" | "tiff" => Some(FileExtension::TIFF),
        "webp" => Some(FileExtension::WEBP),
        "heic" | "heif" => Some(FileExtension::HEIF),
        _ => None,
    }
}

/// True if this engine can write metadata for the given filename.
pub fn supported(filename: &str) -> bool {
    WRITABLE.contains(&ext_of(filename).as_str())
}

/// Canonical extension for a detected format, matching what exiftool's
/// -FileTypeExtension reports so both backends label a file the same way.
pub fn ext_label(ft: FileExtension) -> &'static str {
    match ft {
        FileExtension::JPEG => "jpg",
        FileExtension::PNG { .. } => "png",
        FileExtension::TIFF => "tif",
        FileExtension::WEBP => "webp",
        FileExtension::HEIF => "heic",
        _ => "",
    }
}

/// Decide a file's real format from its magic bytes, falling back to the
/// filename only when the content is unrecognised.
///
/// Extensions lie in practice: a Google Photos export routinely contains JPEGs
/// named `.png`, and writing those as PNG fails outright. exiftool sniffs
/// content, so trusting the name here would make the two engines disagree on
/// real libraries.
pub fn file_type(bytes: &[u8], filename: &str) -> Option<FileExtension> {
    FileExtension::auto_detect(&mut Cursor::new(bytes))
        .or_else(|| type_from_ext(filename))
}

/// Decimal degrees -> the (degrees, minutes, seconds) rational triple EXIF stores.
fn dms(deg: f64) -> Vec<uR64> {
    let a = deg.abs();
    let d = a.floor();
    let m = ((a - d) * 60.0).floor();
    // Seconds at 1/10000 precision: ~1cm of ground resolution, and the numerator
    // stays inside u32 for any legal coordinate.
    let s = (((a - d) * 60.0 - m) * 60.0 * 10_000.0).round() as u32;
    vec![
        uR64 { nominator: d as u32, denominator: 1 },
        uR64 { nominator: m as u32, denominator: 1 },
        uR64 { nominator: s, denominator: 10_000 },
    ]
}

/// The EXIF datetime format: "YYYY:MM:DD HH:MM:SS".
/// The UI speaks ISO ("YYYY-MM-DDTHH:MM:SS"), so convert on the boundary.
fn to_exif_stamp(iso: &str) -> Option<String> {
    if iso.len() < 19 {
        return None;
    }
    let (date, time) = (&iso[0..10], &iso[11..19]);
    Some(format!("{} {}", date.replace('-', ":"), time))
}

/// Apply one photo's edit. `datetime` is ISO or empty, `offset` like "+02:00"
/// or empty; `has_gps` distinguishes "clear the location" from "leave it alone".
pub fn write_tags(
    buf: Vec<u8>,
    ft: FileExtension,
    datetime: &str,
    offset: &str,
    lat: f64,
    lon: f64,
    has_gps: bool,
    clear_gps: bool,
) -> Result<Vec<u8>, String> {
    let mut out = buf;

    // A file carrying no EXIF at all is the normal case for screenshots and
    // exports, which is what this tool exists to fix, so fall back to a
    // fresh metadata block instead of refusing the file.
    let mut md = Metadata::new_from_vec(&out, ft).unwrap_or_else(|_| Metadata::new());

    if matches!(ft, FileExtension::TIFF) {
        // TIFF will not write without these baseline tags present.
        md.set_tag(ExifTag::XResolution(vec![uR64 { nominator: 72, denominator: 1 }]));
        md.set_tag(ExifTag::YResolution(vec![uR64 { nominator: 72, denominator: 1 }]));
        md.set_tag(ExifTag::ResolutionUnit(vec![2u16])); // 2 = inches
    }

    if let Some(stamp) = to_exif_stamp(datetime) {
        // Mirrors exiftool's -AllDates, which is what users mean by "the date".
        md.set_tag(ExifTag::DateTimeOriginal(stamp.clone()));
        md.set_tag(ExifTag::CreateDate(stamp.clone()));
        md.set_tag(ExifTag::ModifyDate(stamp));
    }
    if !offset.is_empty() {
        md.set_tag(ExifTag::OffsetTimeOriginal(offset.to_string()));
        md.set_tag(ExifTag::OffsetTime(offset.to_string()));
        md.set_tag(ExifTag::OffsetTimeDigitized(offset.to_string()));
    }

    if clear_gps {
        md.remove_tag(ExifTag::GPSLatitude(vec![]));
        md.remove_tag(ExifTag::GPSLatitudeRef(String::new()));
        md.remove_tag(ExifTag::GPSLongitude(vec![]));
        md.remove_tag(ExifTag::GPSLongitudeRef(String::new()));
    } else if has_gps {
        // Refs must be written explicitly: the rational triple is unsigned, so
        // the hemisphere lives only in the ref tag.
        md.set_tag(ExifTag::GPSLatitude(dms(lat)));
        md.set_tag(ExifTag::GPSLatitudeRef(
            if lat < 0.0 { "S" } else { "N" }.to_string(),
        ));
        md.set_tag(ExifTag::GPSLongitude(dms(lon)));
        md.set_tag(ExifTag::GPSLongitudeRef(
            if lon < 0.0 { "W" } else { "E" }.to_string(),
        ));
    }

    md.write_to_vec(&mut out, ft).map_err(|e| e.to_string())?;
    Ok(out)
}

/// What a photo carries, as the views need it. Every field is optional because
/// a file may have none of them, which is why this tool exists.
#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    /// "YYYY-MM-DDTHH:MM:SS" wall clock, no zone applied.
    pub datetime: Option<String>,
    /// UTC offset as stored, e.g. "+02:00".
    pub offset: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Needed to render a thumbnail upright.
    pub orientation: u32,
    /// The real format, from the magic bytes rather than the filename.
    pub ext: &'static str,
}

impl Meta {
    fn blank() -> Self {
        Meta { datetime: None, offset: None, lat: None, lon: None, orientation: 1, ext: "" }
    }
}

/// Read the fields the views need. A file with no metadata is not an error.
pub fn read_meta(bytes: &[u8], filename: &str) -> Meta {
    let Some(ft) = file_type(bytes, filename) else {
        return Meta::blank();
    };
    let ext = ext_label(ft);
    let Ok(md) = Metadata::new_from_vec(&bytes.to_vec(), ft) else {
        return Meta { ext, ..Meta::blank() };
    };

    let (mut datetime, mut offset) = (String::new(), String::new());
    let (mut lat_dms, mut lon_dms): (Vec<f64>, Vec<f64>) = (vec![], vec![]);
    let (mut lat_ref, mut lon_ref) = (String::new(), String::new());
    let mut orientation: u32 = 1;

    for tag in md.into_iter() {
        match tag {
            ExifTag::DateTimeOriginal(v) => datetime = clean(&v),
            ExifTag::CreateDate(v) if datetime.is_empty() => datetime = clean(&v),
            ExifTag::ModifyDate(v) if datetime.is_empty() => datetime = clean(&v),
            ExifTag::OffsetTimeOriginal(v) => offset = clean(&v),
            ExifTag::OffsetTime(v) if offset.is_empty() => offset = clean(&v),
            ExifTag::GPSLatitude(v) => lat_dms = rationals(&v),
            ExifTag::GPSLongitude(v) => lon_dms = rationals(&v),
            ExifTag::GPSLatitudeRef(v) => lat_ref = clean(&v),
            ExifTag::GPSLongitudeRef(v) => lon_ref = clean(&v),
            ExifTag::Orientation(v) => orientation = *v.first().unwrap_or(&1) as u32,
            _ => {}
        }
    }

    let (lat, lon) = match (to_deg(&lat_dms, &lat_ref), to_deg(&lon_dms, &lon_ref)) {
        // A lone coordinate is corrupt data; GPS only means anything as a pair.
        (Some(a), Some(b)) => (Some(a), Some(b)),
        _ => (None, None),
    };

    Meta { datetime: from_exif_stamp(&datetime), offset: none_if_empty(offset),
           lat, lon, orientation, ext }
}

fn clean(v: &str) -> String { v.trim_end_matches('\0').trim().to_string() }
fn none_if_empty(s: String) -> Option<String> { (!s.is_empty()).then_some(s) }

fn rationals(v: &[uR64]) -> Vec<f64> {
    v.iter().map(|r| r.nominator as f64 / r.denominator.max(1) as f64).collect()
}

fn to_deg(d: &[f64], r: &str) -> Option<f64> {
    if d.len() < 3 { return None; }
    let v = d[0] + d[1] / 60.0 + d[2] / 3600.0;
    if !v.is_finite() || v > 180.0 { return None; }
    Some(if r == "S" || r == "W" { -v } else { v })
}

/// "YYYY:MM:DD HH:MM:SS" -> ISO "YYYY-MM-DDTHH:MM:SS" for the UI.
pub fn from_exif_stamp(raw: &str) -> Option<String> {
    if raw.len() < 19 || raw.starts_with("0000") { return None; }
    Some(format!("{}T{}", raw[0..10].replace(':', "-"), &raw[11..19]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(v: &[uR64]) -> f64 {
        v[0].nominator as f64
            + v[1].nominator as f64 / 60.0
            + (v[2].nominator as f64 / v[2].denominator as f64) / 3600.0
    }

    #[test]
    fn dms_round_trips_a_positive_coordinate() {
        assert!((approx(&dms(48.8584)) - 48.8584).abs() < 1e-6);
    }

    #[test]
    fn dms_uses_magnitude_only_since_the_ref_tag_carries_the_sign() {
        // EXIF stores unsigned rationals; S/W live in GPSLatitudeRef/LongitudeRef.
        assert_eq!(dms(-33.8688), dms(33.8688));
    }

    #[test]
    fn dms_handles_zero_and_whole_degrees() {
        assert!((approx(&dms(0.0))).abs() < 1e-9);
        assert!((approx(&dms(45.0)) - 45.0).abs() < 1e-9);
    }

    #[test]
    fn iso_becomes_an_exif_stamp() {
        assert_eq!(
            to_exif_stamp("2024-05-01T14:23:11").as_deref(),
            Some("2024:05:01 14:23:11")
        );
    }

    #[test]
    fn a_short_or_empty_stamp_is_rejected_rather_than_truncated() {
        assert!(to_exif_stamp("").is_none());
        assert!(to_exif_stamp("2024-05-01").is_none());
    }

    #[test]
    fn content_wins_over_a_lying_extension() {
        // Google Photos exports contain JPEGs named .png; writing those as PNG
        // fails outright, so the magic bytes must decide.
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0];
        assert!(matches!(file_type(&jpeg, "photo.png"), Some(FileExtension::JPEG)));
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert!(matches!(file_type(&png, "photo.jpg"), Some(FileExtension::PNG { .. })));
    }

    #[test]
    fn unrecognised_content_falls_back_to_the_extension() {
        assert!(matches!(file_type(b"not an image at all", "x.jpg"), Some(FileExtension::JPEG)));
        assert!(file_type(b"not an image at all", "x.txt").is_none());
    }

    #[test]
    fn supported_covers_the_writable_set_and_excludes_raw() {
        for ok in ["a.jpg", "A.JPEG", "b.png", "c.tif", "d.webp", "e.heic", "f.HEIF"] {
            assert!(supported(ok), "{ok} should be supported");
        }
        for no in ["x.cr2", "y.nef", "z.arw", "w.dng", "v.gif", "noextension"] {
            assert!(!supported(no), "{no} should not be supported");
        }
    }
}
