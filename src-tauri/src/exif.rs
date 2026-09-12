//! Thin wrapper around the `exiftool` binary: batched reads, per-file writes.
//!
//! exiftool is the metadata engine for every format we support (JPEG, HEIC/HEIF,
//! PNG, TIFF, WebP). We shell out rather than binding a C library so the same
//! code path covers all of them and so a container/HEIF decoder is never needed
//! just to change a date.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Tags we ask exiftool for. Kept explicit so the JSON payload stays small even
/// on folders with thousands of images.
const READ_TAGS: &[&str] = &[
    "-SourceFile",
    "-FileName",
    "-Directory",
    "-FileSize",
    "-MIMEType",
    "-FileTypeExtension",
    "-DateTimeOriginal",
    "-CreateDate",
    "-ModifyDate",
    "-OffsetTimeOriginal",
    "-OffsetTime",
    "-GPSLatitude",
    "-GPSLongitude",
    "-GPSAltitude",
    "-ImageWidth",
    "-ImageHeight",
    "-Orientation",
    "-Make",
    "-Model",
    "-FileModifyDate",
];

fn exiftool_path() -> Option<&'static PathBuf> {
    static P: OnceLock<Option<PathBuf>> = OnceLock::new();
    P.get_or_init(|| {
        for cand in ["exiftool", "/usr/bin/exiftool", "/usr/local/bin/exiftool"] {
            let p = PathBuf::from(cand);
            if Command::new(&p).arg("-ver").output().is_ok() {
                return Some(p);
            }
        }
        None
    })
    .as_ref()
}

pub fn version() -> Option<String> {
    let et = exiftool_path()?;
    let out = Command::new(et).arg("-ver").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// One photo as the UI sees it. All metadata fields are optional because a file
/// may legitimately carry none of them — that is the whole reason this tool exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Photo {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub mime: Option<String>,
    pub bytes: Option<u64>,
    /// "YYYY-MM-DDTHH:MM:SS" — local wall-clock time as recorded, no zone applied.
    pub datetime: Option<String>,
    /// UTC offset string as stored, e.g. "+02:00".
    pub offset: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub orientation: u32,
    pub camera: Option<String>,
    /// Filesystem mtime, the fallback when a file has no embedded date at all.
    pub file_modified: Option<String>,
}

fn s(v: &serde_json::Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| match x {
        serde_json::Value::String(t) => {
            let t = t.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn f(v: &serde_json::Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| match x {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(t) => t.trim().parse::<f64>().ok(),
        _ => None,
    })
}

/// exiftool stamps look like `2024:05:01 14:23:11` (optionally with a zone or
/// subsecond suffix). Normalise to `2024-05-01T14:23:11` and hand the zone back
/// separately, because the UI treats wall-clock and offset as independent fields.
fn parse_stamp(raw: &str) -> Option<(String, Option<String>)> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with("0000") {
        return None;
    }
    let bytes = raw.as_bytes();
    if raw.len() < 19 || bytes[4] != b':' || bytes[7] != b':' || bytes[10] != b' ' {
        return None;
    }
    let date = format!("{}-{}-{}", &raw[0..4], &raw[5..7], &raw[8..10]);
    let time = &raw[11..19];
    if !time.as_bytes().iter().enumerate().all(|(i, c)| {
        if i == 2 || i == 5 {
            *c == b':'
        } else {
            c.is_ascii_digit()
        }
    }) {
        return None;
    }
    // Anything after the seconds may carry a subsecond part and/or a zone.
    let tail = &raw[19..];
    let zone = tail
        .rfind(['+', '-'])
        .map(|i| &tail[i..])
        .filter(|z| z.len() >= 6)
        .map(|z| z[..6].to_string())
        .or_else(|| tail.contains('Z').then(|| "+00:00".to_string()));
    Some((format!("{date}T{time}"), zone))
}

/// Read metadata for many files in one exiftool invocation.
pub fn read_batch(paths: &[PathBuf]) -> Result<Vec<Photo>, String> {
    let et = exiftool_path().ok_or_else(|| "exiftool not found on PATH".to_string())?;
    if paths.is_empty() {
        return Ok(vec![]);
    }

    let mut cmd = Command::new(et);
    // -n: numeric output, so GPS arrives as signed decimal degrees rather than
    // "48 deg 51' 30.24\" N", and Orientation as an integer.
    cmd.args(["-json", "-n", "-q", "-q"]);
    cmd.args(READ_TAGS);
    cmd.args(paths);

    let out = cmd
        .output()
        .map_err(|e| format!("failed to run exiftool: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(trimmed).map_err(|e| format!("could not parse exiftool json: {e}"))?;

    let mut photos = Vec::with_capacity(arr.len());
    for v in &arr {
        let path = s(v, "SourceFile").unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let p = Path::new(&path);
        let name = s(v, "FileName")
            .or_else(|| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();

        // Prefer DateTimeOriginal (when the shutter fired), then CreateDate,
        // then ModifyDate. Filesystem mtime is offered to the UI separately as a
        // last-resort seed rather than silently pretending it is a capture time.
        let (datetime, zone_from_stamp) = ["DateTimeOriginal", "CreateDate", "ModifyDate"]
            .iter()
            .find_map(|k| s(v, k).and_then(|raw| parse_stamp(&raw)))
            .map(|(d, z)| (Some(d), z))
            .unwrap_or((None, None));

        let offset = s(v, "OffsetTimeOriginal")
            .or_else(|| s(v, "OffsetTime"))
            .or(zone_from_stamp);

        let file_modified = s(v, "FileModifyDate")
            .and_then(|raw| parse_stamp(&raw))
            .map(|(d, _)| d);

        let camera = match (s(v, "Make"), s(v, "Model")) {
            (Some(mk), Some(md)) if md.starts_with(&mk) => Some(md),
            (Some(mk), Some(md)) => Some(format!("{mk} {md}")),
            (None, Some(md)) => Some(md),
            (Some(mk), None) => Some(mk),
            _ => None,
        };

        // GPS is only meaningful as a pair; a lone coordinate is corrupt data.
        let (lat, lon) = match (
            f(v, "GPSLatitude").filter(|x| x.is_finite() && x.abs() <= 90.0),
            f(v, "GPSLongitude").filter(|x| x.is_finite() && x.abs() <= 180.0),
        ) {
            (Some(la), Some(lo)) => (Some(la), Some(lo)),
            _ => (None, None),
        };

        photos.push(Photo {
            ext: s(v, "FileTypeExtension")
                .or_else(|| p.extension().map(|e| e.to_string_lossy().into_owned()))
                .unwrap_or_default()
                .to_lowercase(),
            name,
            mime: s(v, "MIMEType"),
            bytes: f(v, "FileSize").map(|b| b as u64),
            datetime,
            offset,
            lat,
            lon,
            alt: f(v, "GPSAltitude").filter(|x| x.is_finite()),
            width: f(v, "ImageWidth").map(|x| x as u32),
            height: f(v, "ImageHeight").map(|x| x as u32),
            orientation: f(v, "Orientation").map(|x| x as u32).unwrap_or(1),
            camera,
            file_modified,
            path,
        });
    }
    Ok(photos)
}

/// Extract an embedded preview/thumbnail JPEG without decoding the full image.
/// This is what makes HEIC folders load fast and is the only cheap way to get a
/// pixel preview of a HEIC at all without pulling in libheif.
pub fn embedded_preview(path: &Path) -> Option<Vec<u8>> {
    let et = exiftool_path()?;
    for tag in ["-PreviewImage", "-JpgFromRaw", "-ThumbnailImage"] {
        let out = Command::new(et)
            .args(["-b", tag, "-q", "-q"])
            .arg(path)
            .output()
            .ok()?;
        // A JPEG SOI marker is the cheapest validity check available.
        if out.stdout.len() > 1024 && out.stdout.starts_with(&[0xFF, 0xD8]) {
            return Some(out.stdout);
        }
    }
    None
}

/// One file's worth of requested changes. `None` means "leave this field alone".
#[derive(Debug, Clone, Deserialize)]
pub struct Edit {
    pub path: String,
    /// "YYYY-MM-DDTHH:MM:SS" wall clock.
    pub datetime: Option<String>,
    pub offset: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt: Option<f64>,
    /// Explicitly strip GPS rather than set it.
    #[serde(default)]
    pub clear_gps: bool,
}

pub fn build_args(edit: &Edit) -> Vec<String> {
    let mut a: Vec<String> = vec!["-n".into(), "-q".into(), "-q".into()];

    if let Some(dt) = edit.datetime.as_deref().filter(|d| d.len() >= 19) {
        // -AllDates covers DateTimeOriginal, CreateDate and ModifyDate in one go,
        // which is what users mean by "the photo's date".
        let stamp = format!("{} {}", dt[0..10].replace('-', ":"), &dt[11..19]);
        a.push(format!("-AllDates={stamp}"));
    }
    if let Some(off) = edit.offset.as_deref().filter(|o| !o.is_empty()) {
        for tag in ["OffsetTimeOriginal", "OffsetTime", "OffsetTimeDigitized"] {
            a.push(format!("-{tag}={off}"));
        }
    }

    if edit.clear_gps {
        a.push("-GPS:all=".into());
        a.push("-XMP:GPSLatitude=".into());
        a.push("-XMP:GPSLongitude=".into());
    } else if let (Some(lat), Some(lon)) = (edit.lat, edit.lon) {
        // Refs must be written explicitly: with -n exiftool takes the signed value
        // verbatim and will not infer the hemisphere on its own.
        a.push(format!("-GPSLatitude={}", lat.abs()));
        a.push(format!("-GPSLatitudeRef={}", if lat < 0.0 { "S" } else { "N" }));
        a.push(format!("-GPSLongitude={}", lon.abs()));
        a.push(format!("-GPSLongitudeRef={}", if lon < 0.0 { "W" } else { "E" }));
        if let Some(alt) = edit.alt.filter(|v| v.is_finite()) {
            a.push(format!("-GPSAltitude={}", alt.abs()));
            a.push(format!("-GPSAltitudeRef={}", if alt < 0.0 { 1 } else { 0 }));
        }
    }
    a
}

/// Apply one edit to `target` in place. The caller decides whether `target` is
/// the original or a copy.
pub fn write_one(target: &Path, edit: &Edit, keep_backup: bool) -> Result<(), String> {
    let et = exiftool_path().ok_or_else(|| "exiftool not found on PATH".to_string())?;
    let args = build_args(edit);
    if args.len() <= 3 {
        return Ok(()); // nothing but the standing flags — no change requested
    }

    let mut cmd = Command::new(et);
    if !keep_backup {
        cmd.arg("-overwrite_original");
    }
    cmd.args(&args);
    cmd.arg(target);

    let out = cmd
        .output()
        .map_err(|e| format!("failed to run exiftool: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        Err(if err.is_empty() {
            format!("exiftool exited with {}", out.status)
        } else {
            err.lines().next().unwrap_or(err).to_string()
        })
    }
}
