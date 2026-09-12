//! Output-path helpers. Kept apart from the Tauri command layer so the rules
//! that decide *where a file lands* can be tested on their own — these run in
//! the one code path that touches the user's disk.

use std::path::{Path, PathBuf};

/// Pick a destination inside `dir` for `src`'s filename, never overwriting an
/// existing file: `IMG_1.jpg`, then `IMG_1 (1).jpg`, and so on.
pub fn dest_for(dir: &Path, src: &Path) -> PathBuf {
    dest_for_with(dir, src, |p| p.exists())
}

/// Testable core: `taken` decides whether a candidate is already in use.
pub fn dest_for_with(dir: &Path, src: &Path, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    let ext = src.extension().map(|s| s.to_string_lossy().into_owned());

    let candidate = |n: usize| -> PathBuf {
        let base = if n == 0 { stem.clone() } else { format!("{stem} ({n})") };
        dir.join(match &ext {
            Some(e) => format!("{base}.{e}"),
            None => base,
        })
    };

    (0..10_000)
        .map(candidate)
        .find(|p| !taken(p))
        // Pathological case only: 10k same-named files. Better to collide loudly
        // than to invent an unbounded name.
        .unwrap_or_else(|| candidate(0))
}

/// Suggested sibling output folder: /photos/trip -> /photos/trip_tagged.
pub fn suggest_out_dir(folder: &str) -> String {
    let p = Path::new(folder);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "photos".into());
    p.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.join(format!("{name}_tagged")))
        .unwrap_or_else(|| PathBuf::from(format!("{folder}_tagged")))
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn taken_set(v: &[&str]) -> HashSet<PathBuf> {
        v.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn free_name_is_used_as_is() {
        let t = taken_set(&[]);
        assert_eq!(
            dest_for_with(Path::new("/out"), Path::new("/in/IMG_1.jpg"), |p| t.contains(p)),
            PathBuf::from("/out/IMG_1.jpg")
        );
    }

    #[test]
    fn collisions_get_a_counter_and_keep_the_extension() {
        let t = taken_set(&["/out/IMG_1.jpg", "/out/IMG_1 (1).jpg"]);
        assert_eq!(
            dest_for_with(Path::new("/out"), Path::new("/in/IMG_1.jpg"), |p| t.contains(p)),
            PathBuf::from("/out/IMG_1 (2).jpg")
        );
    }

    #[test]
    fn dotted_names_keep_only_the_final_extension() {
        let t = taken_set(&[]);
        assert_eq!(
            dest_for_with(Path::new("/out"), Path::new("/in/a.b.c.jpg"), |p| t.contains(p)),
            PathBuf::from("/out/a.b.c.jpg")
        );
    }

    #[test]
    fn extensionless_files_survive() {
        let t = taken_set(&["/out/photo"]);
        assert_eq!(
            dest_for_with(Path::new("/out"), Path::new("/in/photo"), |p| t.contains(p)),
            PathBuf::from("/out/photo (1)")
        );
    }

    #[test]
    fn out_dir_is_a_sibling_of_the_source() {
        assert_eq!(suggest_out_dir("/home/me/Pictures/trip"), "/home/me/Pictures/trip_tagged");
    }

    #[test]
    fn trailing_slash_does_not_produce_an_empty_name() {
        assert_eq!(suggest_out_dir("/home/me/Pictures/trip/"), "/home/me/Pictures/trip_tagged");
    }

    #[test]
    fn a_bare_relative_name_still_gets_a_suffix() {
        assert_eq!(suggest_out_dir("trip"), "trip_tagged");
    }
}
