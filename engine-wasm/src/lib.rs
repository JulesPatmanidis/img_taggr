//! Browser wrapper around `img-taggr-core`.
//!
//! Holds no metadata logic of its own — it converts between JS values and the
//! shared engine, so the browser and desktop cannot diverge on what a save does.

use img_taggr_core as core;
use wasm_bindgen::prelude::*;

/// True if this engine can write metadata for the given filename.
#[wasm_bindgen]
pub fn supported(filename: &str) -> bool {
    core::supported(filename)
}

/// The writable extensions, comma separated. The UI builds its file-dialog
/// filter from this so the list exists in exactly one place.
#[wasm_bindgen]
pub fn writable_extensions() -> String {
    core::WRITABLE.join(",")
}

/// Why this file cannot be tagged, or `undefined` if it can. The importer calls
/// it once it has the bytes, so a file that could never be saved never reaches
/// the list.
#[wasm_bindgen]
pub fn reject_reason(bytes: &[u8], filename: &str) -> Option<String> {
    core::reject_reason(bytes, filename).map(str::to_owned)
}

/// Read the fields the UI needs, as JSON. `{}` means "nothing readable here",
/// which is a normal state rather than an error.
#[wasm_bindgen]
pub fn read_meta(bytes: Vec<u8>, filename: &str) -> String {
    let m = core::read_meta(&bytes, filename);
    let mut parts = vec![
        format!("\"orientation\":{}", m.orientation),
        format!("\"ext\":\"{}\"", m.ext),
    ];
    if let Some(d) = m.datetime { parts.push(format!("\"datetime\":\"{d}\"")); }
    if let Some(o) = m.offset { parts.push(format!("\"offset\":\"{o}\"")); }
    if let (Some(la), Some(lo)) = (m.lat, m.lon) {
        parts.push(format!("\"lat\":{la},\"lon\":{lo}"));
    }
    format!("{{{}}}", parts.join(","))
}

/// Write an edit and return the new file bytes. Throws on failure so the caller
/// can report which file failed and why.
#[wasm_bindgen]
pub fn write_meta(
    bytes: Vec<u8>,
    filename: &str,
    datetime: &str,
    offset: &str,
    lat: f64,
    lon: f64,
    has_gps: bool,
    clear_gps: bool,
) -> Result<Vec<u8>, JsValue> {
    let ft = core::file_type(&bytes, filename).ok_or_else(|| {
        JsValue::from_str(&format!("{}: unsupported format", core::ext_of(filename)))
    })?;
    core::write_tags(bytes, ft, datetime, offset, lat, lon, has_gps, clear_gps)
        .map_err(|e| JsValue::from_str(&e))
}
