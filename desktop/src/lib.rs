//! img-taggr: offline photo time and location metadata editor.
//!
//! The Rust side does all filesystem access while the webview handles interaction.
//! Nothing here reaches the network, and no image bytes leave the machine.

mod exif;
mod paths;
mod thumb;

use exif::{Edit, Photo};
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Formats this build can open.
/// same as `WRITABLE` in `engine/src/lib.rs`.
const SUPPORTED: &[&str] = &[
    "jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "webp",
];

#[derive(Serialize)]
pub struct ScanResult {
    photos: Vec<Photo>,
    /// Files that looked like images but could not be read.
    unreadable: usize,
    /// The deepest folder containing every source in this batch; the output
    /// folder is suggested as its sibling. Empty when there is none.
    folder: String,
}

fn is_supported(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Every supported image inside a folder, subfolders included when `recursive`.
fn walk(root: &Path, recursive: bool) -> Vec<PathBuf> {
    WalkDir::new(root)
        .max_depth(if recursive { 12 } else { 1 })
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| is_supported(p))
        // `name.ext_original` backups are skipped.
        .filter(|p| {
            !p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with("_original"))
                .unwrap_or(false)
        })
        .collect()
}

/// Read a batch of sources, each either a folder to walk or a single image.
#[tauri::command]
fn scan_paths(paths: Vec<String>, recursive: bool) -> Result<ScanResult, String> {
    if paths.is_empty() {
        return Err("nothing to open".into());
    }

    let mut files: Vec<PathBuf> = Vec::new();
    // Folders the output folder is suggested from. Can be the source folder itself, or
    // or the parent folder of a loose file.
    let mut roots: Vec<PathBuf> = Vec::new();
    for raw in &paths {
        let path = PathBuf::from(raw);
        if path.is_dir() {
            files.extend(walk(&path, recursive));
            roots.push(path);
        } else if path.is_file() {
            // A file the user pointed at directly is not silently skipped for
            // its extension; the read below reports why it could not be used.
            files.push(path.clone());
            if let Some(parent) = path.parent() {
                roots.push(parent.to_path_buf());
            }
        } else {
            return Err(format!("not a file or folder: {raw}"));
        }
    }
    files.sort();
    files.dedup();

    let total = files.len();
    // Returned in filename order.
    let photos: Vec<Photo> = exif::read_batch(&files);

    Ok(ScanResult {
        unreadable: total.saturating_sub(photos.len()),
        // Sources sharing no ancestor (two drives, say) fall back to the first.
        folder: paths::common_root(&roots)
            .or_else(|| roots.first().cloned())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
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

#[derive(Serialize)]
pub struct ItemResult {
    path: String,
    ok: bool,
    error: Option<String>,
}

/// Write the edits out as a fresh set of files in `out_dir`. Sources are never
/// opened for writing.
#[tauri::command]
async fn apply_edits(items: Vec<Edit>, out_dir: String) -> Result<Vec<ItemResult>, String> {
    if out_dir.is_empty() {
        return Err("saving needs an output folder".into());
    }
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create {out_dir}: {e}"))?;
    let out_dir = PathBuf::from(out_dir);

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

                // create_dest creates the file, so parallel saves of two
                // same-named sources never write to the same path.
                let target = match paths::create_dest(&out_dir, &src) {
                    Ok(t) => t,
                    Err(e) => {
                        res.error = Some(format!("cannot create output file: {e}"));
                        return res;
                    }
                };
                if let Err(e) = std::fs::copy(&src, &target) {
                    let _ = std::fs::remove_file(&target);
                    res.error = Some(format!("copy failed: {e}"));
                    return res;
                }

                match exif::write_one(&target, edit) {
                    Ok(()) => res.ok = true,
                    Err(e) => {
                        // Never leave an untagged copy that looks finished.
                        let _ = std::fs::remove_file(&target);
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
            scan_paths,
            load_thumb,
            load_preview,
            apply_edits,
            suggest_out_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running img-taggr");
}
