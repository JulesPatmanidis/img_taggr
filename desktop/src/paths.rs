//! Output-path helpers.

use std::path::{Path, PathBuf};

/// Every name `src` could take inside `dir`, in order: `IMG_1.jpg`, then
/// `IMG_1 (1).jpg`, and so on. The sequence is infinite in principle; callers
/// bound it.
fn candidates(dir: &Path, src: &Path) -> impl Iterator<Item = PathBuf> {
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    let ext = src.extension().map(|s| s.to_string_lossy().into_owned());
    let dir = dir.to_path_buf();

    (0..10_000).map(move |n| {
        let base = if n == 0 { stem.clone() } else { format!("{stem} ({n})") };
        dir.join(match &ext {
            Some(e) => format!("{base}.{e}"),
            None => base,
        })
    })
}

/// Create an empty file in `dir` named after `src`, adding a counter when the
/// name exists, and return its path. Never overwrites an existing file.
///
/// Uses `create_new` rather than an existence check, so concurrent calls for
/// the same name create distinct files: a call that gets `AlreadyExists` tries
/// the next candidate.
pub fn create_dest(dir: &Path, src: &Path) -> std::io::Result<PathBuf> {
    for candidate in candidates(dir, src) {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    // Pathological case only: 10k files of one name. Better to fail loudly than
    // to invent an unbounded name.
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many files of the same name in the output folder",
    ))
}

/// The deepest directory that contains every one of `dirs`, or `None` when they
/// share nothing (a mix of relative paths, or two Windows drives).
pub fn common_root(dirs: &[PathBuf]) -> Option<PathBuf> {
    let mut rest = dirs.iter();
    let mut root = rest.next()?.clone();
    for d in rest {
        // pop() returning false means the root has no parent left to give up,
        // so there is nothing these two share at all.
        while !d.starts_with(&root) {
            if !root.pop() {
                return None;
            }
        }
    }
    (!root.as_os_str().is_empty()).then_some(root)
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

    /// The path `create_dest` would create, computed without touching the
    /// filesystem.
    fn dest_for_with(dir: &Path, src: &Path, taken: impl Fn(&Path) -> bool) -> PathBuf {
        candidates(dir, src)
            .find(|p| !taken(p))
            .unwrap_or_else(|| dir.join("image"))
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

    fn root_of(v: &[&str]) -> Option<String> {
        let dirs: Vec<PathBuf> = v.iter().map(PathBuf::from).collect();
        common_root(&dirs).map(|p| p.to_string_lossy().into_owned())
    }

    #[test]
    fn one_source_is_its_own_root() {
        assert_eq!(root_of(&["/home/me/trip"]).as_deref(), Some("/home/me/trip"));
    }

    #[test]
    fn sources_under_one_folder_share_it() {
        assert_eq!(
            root_of(&["/home/me/trip/day1", "/home/me/trip/day2", "/home/me/trip"]).as_deref(),
            Some("/home/me/trip")
        );
    }

    #[test]
    fn unrelated_sources_fall_back_to_the_deepest_shared_folder() {
        assert_eq!(root_of(&["/home/me/trip", "/home/you/scans"]).as_deref(), Some("/home"));
    }

    /// A temporary folder, deleted on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("img-taggr-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn create_dest_claims_a_free_name_and_leaves_the_file_standing() {
        let out = Scratch::new("claim");
        let first = create_dest(&out.0, Path::new("/in/IMG_1.jpg")).unwrap();
        assert_eq!(first, out.0.join("IMG_1.jpg"));
        assert!(first.is_file(), "the claim has to exist, or it claims nothing");

        // A second source holding the same filename gets the next name, not the
        // first one's file.
        let second = create_dest(&out.0, Path::new("/elsewhere/IMG_1.jpg")).unwrap();
        assert_eq!(second, out.0.join("IMG_1 (1).jpg"));
    }

    #[test]
    fn concurrent_claims_on_one_name_never_collide() {
        use std::collections::HashSet;
        let out = Scratch::new("race");
        let claimed: Vec<PathBuf> = std::thread::scope(|s| {
            let hands: Vec<_> = (0..16)
                .map(|_| s.spawn(|| create_dest(&out.0, Path::new("/in/IMG_1.jpg")).unwrap()))
                .collect();
            hands.into_iter().map(|h| h.join().unwrap()).collect()
        });
        // The whole point: sixteen threads, sixteen distinct files, nothing
        // overwritten. An exists()-then-copy check fails this.
        assert_eq!(claimed.iter().collect::<HashSet<_>>().len(), 16);
    }

    #[test]
    fn nothing_shared_is_no_root_rather_than_an_empty_path() {
        assert_eq!(root_of(&[]), None);
        assert_eq!(root_of(&["trip", "scans"]), None);
        // An absolute and a relative source have no common ancestor at all.
        assert_eq!(root_of(&["/home/me/trip", "scans"]), None);
    }
}
