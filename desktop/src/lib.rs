//! img-taggr — offline photo time & location metadata editor.
//!
//! The Rust side owns the filesystem and exiftool; the webview owns interaction.
//! Nothing here reaches the network, and no image bytes leave the machine.

mod exif;
mod paths;
mod thumb;

use exif::{Edit, Photo};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Formats we are willing to open. Deliberately excludes camera RAW: rewriting
/// a RAW container is far easier to get wrong, and silently corrupting a
/// negative is not an acceptable failure mode for a metadata editor.
const SUPPORTED: &[&str] = &[
    "jpg", "jpeg", "jpe", "heic", "heif", "png", "tif", "tiff", "webp",
];

#[derive(Serialize)]
pub struct ScanResult {
    photos: Vec<Photo>,
    /// Files that looked like images but could not be read.
    unreadable: usize,
    folder: String,
}

#[tauri::command]
fn scan_folder(path: String, recursive: bool) -> Result<ScanResult, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a folder: {path}"));
    }

    let mut files: Vec<PathBuf> = WalkDir::new(&root)
        .max_depth(if recursive { 12 } else { 1 })
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| SUPPORTED.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        })
        // Backups sit next to originals; never treat one as a fresh photo or a
        // second pass would re-tag stale copies.
        .filter(|p| {
            !p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with("_original"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();

    let total = files.len();
    // Chunked so a folder with 10k images does not build one enormous argv.
    let mut photos: Vec<Photo> = exif::read_batch(&files);

    // Order by capture time when known, filename otherwise. This ordering is
    // what the timeline and the map-interpolation both walk, so it matters.
    photos.sort_by(|a, b| match (&a.datetime, &b.datetime) {
        (Some(x), Some(y)) => x.cmp(y).then_with(|| a.name.cmp(&b.name)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    Ok(ScanResult {
        unreadable: total.saturating_sub(photos.len()),
        folder: root.to_string_lossy().into_owned(),
        photos,
    })
}

/// Decoding is slow, so keep it off the thread that serves IPC.
async fn render_image(path: String, orientation: u32, size: thumb::Size) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || thumb::make(Path::new(&path), orientation, size))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn load_thumb(path: String, orientation: u32) -> Option<String> {
    render_image(path, orientation, thumb::Size::Thumb).await
}

#[tauri::command]
async fn load_preview(path: String, orientation: u32) -> Option<String> {
    render_image(path, orientation, thumb::Size::Preview).await
}

/// How a save writes its results. The ids match `SAVE_MODES` in
/// `app/backend.js`, which renders the radio list from the same names; an id
/// that is not one of these fails to deserialize, so a typo is an error rather
/// than a silent fall-through to overwriting the originals.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SaveMode {
    /// Tagged copies into an output folder; originals never opened for writing.
    Copy,
    /// Edit the original, keeping `name.ext_original` beside it.
    Backup,
    /// Edit the original with no backup.
    Inplace,
}

#[derive(Serialize)]
pub struct ItemResult {
    path: String,
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
async fn apply_edits(
    items: Vec<Edit>,
    mode: SaveMode,
    out_dir: Option<String>,
) -> Result<Vec<ItemResult>, String> {
    // Exhaustive on purpose: a new mode must decide here whether it writes
    // somewhere else, rather than inheriting "edit the original" by default.
    let copy_dir = match mode {
        SaveMode::Copy => {
            let dir = out_dir
                .as_deref()
                .filter(|d| !d.is_empty())
                .ok_or_else(|| "copy mode needs an output folder".to_string())?;
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {dir}: {e}"))?;
            Some(PathBuf::from(dir))
        }
        SaveMode::Backup | SaveMode::Inplace => None,
    };

    let results = tauri::async_runtime::spawn_blocking(move || {
        items
            .par_iter()
            .map(|edit| {
                let src = PathBuf::from(&edit.path);
                let mut res = ItemResult {
                    path: edit.path.clone(),
                    ok: false,
                    error: None,
                };
                if !src.is_file() {
                    res.error = Some("file no longer exists".into());
                    return res;
                }

                let (target, keep_backup) = match copy_dir.as_deref() {
                    Some(dir) => {
                        let dst = paths::dest_for(dir, &src);
                        if let Err(e) = std::fs::copy(&src, &dst) {
                            res.error = Some(format!("copy failed: {e}"));
                            return res;
                        }
                        (dst, false)
                    }
                    None => (src.clone(), mode == SaveMode::Backup),
                };

                match exif::write_one(&target, edit, keep_backup) {
                    Ok(()) => res.ok = true,
                    Err(e) => {
                        // A copy we failed to tag is worse than no copy at all:
                        // it looks like a finished result but carries old data.
                        if copy_dir.is_some() {
                            let _ = std::fs::remove_file(&target);
                        }
                        res.error = Some(e);
                    }
                }
                res
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("apply task failed: {e}"))?;

    Ok(results)
}

/// Suggested sibling output folder, e.g. /photos/trip -> /photos/trip_tagged.
#[tauri::command]
fn suggest_out_dir(folder: String) -> String {
    paths::suggest_out_dir(&folder)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            load_thumb,
            load_preview,
            apply_edits,
            suggest_out_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running img-taggr");
}
