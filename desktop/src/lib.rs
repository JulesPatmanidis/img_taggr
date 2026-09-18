//! img-taggr: offline photo time and location metadata editor.
//!
//! The Rust side owns the filesystem and exiftool; the webview owns interaction.
//! Nothing here reaches the network, and no image bytes leave the machine.

mod exif;
mod paths;
mod thumb;

use exif::{Edit, Photo};
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Formats we are willing to open, which is exactly what the engine can write
/// back (`WRITABLE` in `engine/src/lib.rs`). Opening anything more would mean
/// accepting edits that fail at save. Camera RAW is excluded deliberately:
/// rewriting a RAW container is far easier to get wrong, and silently
/// corrupting a negative is not an acceptable failure mode.
const SUPPORTED: &[&str] = &[
    "jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "webp",
];

#[derive(Serialize)]
pub struct ScanResult {
    photos: Vec<Photo>,
    /// Files that looked like images but could not be read.
    unreadable: usize,
    /// The deepest folder holding every source in this batch, which is what an
    /// output folder is suggested next to. Empty when they share nothing.
    folder: String,
}

fn is_supported(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Every supported image inside a folder, newest structure and all.
fn walk(root: &Path, recursive: bool) -> Vec<PathBuf> {
    WalkDir::new(root)
        .max_depth(if recursive { 12 } else { 1 })
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| is_supported(p))
        // Backups sit next to originals; never treat one as a fresh photo or a
        // second pass would re-tag stale copies.
        .filter(|p| {
            !p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with("_original"))
                .unwrap_or(false)
        })
        .collect()
}

/// Read a batch of sources, each either a folder to walk or a single image.
/// Folders and loose files arrive through the same door so that picking,
/// dropping and adding one more photo are all the same operation.
#[tauri::command]
fn scan_paths(paths: Vec<String>, recursive: bool) -> Result<ScanResult, String> {
    if paths.is_empty() {
        return Err("nothing to open".into());
    }

    let mut files: Vec<PathBuf> = Vec::new();
    // Where the output folder should be suggested: a source folder stands for
    // itself, a loose file for the folder it sits in.
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
    // Chunked so a folder with 10k images does not build one enormous argv.
    // Handed back in filename order, because the front end owns the capture
    // ordering and re-sorts on every datetime edit anyway.
    let photos: Vec<Photo> = exif::read_batch(&files);

    Ok(ScanResult {
        unreadable: total.saturating_sub(photos.len()),
        // Sources sharing no ancestor (two drives, say) still need a name for
        // the bar and for the suggested output folder; the first one will do.
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

/// Write the edits out as a fresh set of files in `out_dir`. There is only one
/// way to save: the sources are never opened for writing, whatever folders they
/// came from, so an edit can always be undone by deleting the output.
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

                // Photos from several folders land in one flat output folder, so
                // two sources holding an IMG_0001.jpg each must not collide.
                // Claiming the name creates the file, which is what makes it
                // safe to do this from several threads at once.
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
                        // A copy we failed to tag is worse than no copy at all:
                        // it looks like a finished result but carries old data.
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
