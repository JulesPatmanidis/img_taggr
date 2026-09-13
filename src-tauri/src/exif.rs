//! Desktop file I/O around the shared metadata engine.
//!
//! There is no second implementation here: reading and writing both go through
//! `img_taggr_core`, the same code the browser build runs. This file only deals
//! with what a browser cannot — touching the filesystem.

use img_taggr_core as core;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One photo as the UI sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Photo {
    pub path: String,
    pub name: String,
    pub ext: String,
    /// "YYYY-MM-DDTHH:MM:SS" — wall-clock time as recorded, no zone applied.
    pub datetime: Option<String>,
    /// UTC offset string as stored, e.g. "+02:00".
    pub offset: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Needed to render thumbnails upright.
    pub orientation: u32,
    /// Filesystem mtime, the fallback when a file has no embedded date at all.
    pub file_modified: Option<String>,
}

/// Filesystem mtime as "YYYY-MM-DDTHH:MM:SS" in local time.
fn modified_at(path: &Path) -> Option<String> {
    let secs = std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;

    // Civil-from-days, so no date/time crate is needed for one timestamp.
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Some(format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}",
        rem / 3600, (rem % 3600) / 60, rem % 60
    ))
}

fn read_one(path: &Path) -> Option<Photo> {
    let bytes = std::fs::read(path).ok()?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    let m = core::read_meta(&bytes, &name);
    Some(Photo {
        ext: if m.ext.is_empty() {
            path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
        } else {
            m.ext.to_string()
        },
        name,
        datetime: m.datetime,
        offset: m.offset,
        lat: m.lat,
        lon: m.lon,
        orientation: m.orientation,
        file_modified: modified_at(path),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Read metadata for many files. Reads are independent, so they parallelize.
pub fn read_batch(paths: &[PathBuf]) -> Vec<Photo> {
    paths.par_iter().filter_map(|p| read_one(p)).collect()
}

/// One file's worth of requested changes.
#[derive(Debug, Clone, Deserialize)]
pub struct Edit {
    pub path: String,
    /// "YYYY-MM-DDTHH:MM:SS" wall clock.
    pub datetime: Option<String>,
    pub offset: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Explicitly strip GPS rather than set it.
    #[serde(default)]
    pub clear_gps: bool,
}

/// Apply one edit to `target`, in place. The caller decides whether `target` is
/// the original or a copy it made first.
pub fn write_one(target: &Path, edit: &Edit, keep_backup: bool) -> Result<(), String> {
    let bytes = std::fs::read(target).map_err(|e| format!("cannot read: {e}"))?;
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ft = core::file_type(&bytes, &name)
        .ok_or_else(|| format!("{}: unsupported format", core::ext_of(&name)))?;

    if keep_backup {
        // Same convention exiftool uses, so existing backups stay recognisable.
        let backup = target.with_file_name(format!("{name}_original"));
        if !backup.exists() {
            std::fs::copy(target, &backup).map_err(|e| format!("backup failed: {e}"))?;
        }
    }

    let out = core::write_tags(
        bytes,
        ft,
        edit.datetime.as_deref().unwrap_or(""),
        edit.offset.as_deref().unwrap_or(""),
        edit.lat.unwrap_or(0.0),
        edit.lon.unwrap_or(0.0),
        edit.lat.is_some() && edit.lon.is_some(),
        edit.clear_gps,
    )?;
    std::fs::write(target, out).map_err(|e| format!("cannot write: {e}"))
}
