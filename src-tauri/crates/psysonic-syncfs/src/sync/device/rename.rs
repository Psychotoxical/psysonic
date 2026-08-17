/// Joins a migration path onto the device root, or returns `None` if it could
/// end up anywhere else.
///
/// These paths are rendered from `filenameTemplate` in `psysonic-sync.json`,
/// which lives on the device — untrusted input, whatever wrote it. Three shapes
/// leave the root, and `Path::join` helps none of them:
///
/// * `..` walks out of the directory the user picked;
/// * an absolute path (`/etc/x`, `C:\Windows\x`) makes `join` **discard the
///   root entirely** and return the absolute path as-is;
/// * a Windows prefix does the same, including UNC (`\\server\share`), which
///   would reach across the network.
///
/// Only `Normal` components — and `.`, which goes nowhere — are accepted.
pub(super) fn resolve_within_root(root: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    use std::path::Component;
    if rel.trim().is_empty() {
        return None;
    }
    let candidate = std::path::Path::new(rel);
    for component in candidate.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(root.join(candidate))
}

/// Whether `path` still resolves inside `root` once the filesystem has had its
/// say. `resolve_within_root` reads the path as text and cannot see a symlink;
/// a device that ships `Artist -> /somewhere/else` passes the syntax check and
/// lands outside anyway.
///
/// The error is kept rather than folded into `false`: a drive pulled mid-
/// migration fails to canonicalize too, and reporting that as a containment
/// violation would tell the user something untrue about their own device.
fn resolved_path_stays_within(
    root: &std::path::Path,
    path: &std::path::Path,
) -> std::io::Result<bool> {
    let canonical_root = root.canonicalize()?;
    let canonical_path = path.canonicalize()?;
    Ok(canonical_path.starts_with(&canonical_root))
}

/// Same question for a path that does not exist yet: walks up to the closest
/// ancestor that does and checks that one.
///
/// Needed because the target's parent is created before anything is moved
/// there. Checking only after `create_dir_all` is too late — the directories
/// would already exist, outside the root, which is half of what this guards
/// against even when the rename itself is then refused.
pub(super) fn planned_path_stays_within(
    root: &std::path::Path,
    path: &std::path::Path,
) -> std::io::Result<bool> {
    let mut current = path;
    loop {
        if current.exists() {
            return resolved_path_stays_within(root, current);
        }
        match current.parent() {
            Some(parent) => current = parent,
            // Ran out of ancestors without meeting anything real: the path does
            // not belong to the device tree at all.
            None => return Ok(false),
        }
    }
}

/// Per-entry result for `rename_device_files`.
#[derive(serde::Serialize, specta::Type)]
pub struct RenameResult {
    #[serde(rename = "oldPath")]
    pub(super) old_path: String,
    #[serde(rename = "newPath")]
    pub(super) new_path: String,
    pub(super) ok: bool,
    pub(super) error: Option<String>,
}

/// Checks both ends of one rename against the root and returns the message to
/// report, or `None` when the pair is contained. Runs before anything is
/// created or moved.
fn containment_refusal(
    root: &std::path::Path,
    old_abs: &std::path::Path,
    new_abs: &std::path::Path,
) -> Option<String> {
    match (
        resolved_path_stays_within(root, old_abs),
        planned_path_stays_within(root, new_abs),
    ) {
        (Ok(true), Ok(true)) => None,
        // A definite escape on either side outranks an unresolved other side:
        // what is known beats what is not.
        (Ok(false), _) | (_, Ok(false)) => Some("path escapes the device root".to_string()),
        // Either side failed to resolve. A drive pulled mid-migration looks like
        // this, and calling that a containment violation would be a lie.
        (Err(e), _) | (_, Err(e)) => Some(format!("could not resolve path: {e}")),
    }
}

/// The renaming itself, separated from the volume checks above so the path
/// containment can be tested: `is_path_on_mounted_volume` rejects a temporary
/// directory, which is where a test would put its fixture.
pub(super) fn rename_pairs_within_root(
    root: &std::path::Path,
    pairs: Vec<(String, String)>,
) -> Vec<RenameResult> {
    let mut results = Vec::with_capacity(pairs.len());
    for (old_rel, new_rel) in pairs {
        // Both sides are checked, not just the one the template renders: the
        // command is part of the Tauri surface and cannot assume its caller.
        let (Some(old_abs), Some(new_abs)) = (
            resolve_within_root(root, &old_rel),
            resolve_within_root(root, &new_rel),
        ) else {
            results.push(RenameResult {
                old_path: old_rel,
                new_path: new_rel,
                ok: false,
                error: Some("path escapes the device root".to_string()),
            });
            continue;
        };

        let entry = if old_rel == new_rel {
            // Nothing to do, count as success so the UI can show "already correct".
            RenameResult {
                old_path: old_rel,
                new_path: new_rel,
                ok: true,
                error: None,
            }
        } else if !old_abs.exists() {
            RenameResult {
                old_path: old_rel,
                new_path: new_rel,
                ok: false,
                error: Some("source not found".to_string()),
            }
        } else if let Some(refusal) = containment_refusal(root, &old_abs, &new_abs) {
            RenameResult {
                old_path: old_rel,
                new_path: new_rel,
                ok: false,
                error: Some(refusal),
            }
        } else if new_abs.exists() {
            RenameResult {
                old_path: old_rel,
                new_path: new_rel,
                ok: false,
                error: Some("target already exists".to_string()),
            }
        } else {
            // Ensure target parent exists.
            if let Some(parent) = new_abs.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    results.push(RenameResult {
                        old_path: old_rel,
                        new_path: new_rel,
                        ok: false,
                        error: Some(format!("mkdir: {}", e)),
                    });
                    continue;
                }
                // Containment was settled before this ran (`containment_refusal`),
                // so nothing here can land outside the root.
            }
            match std::fs::rename(&old_abs, &new_abs) {
                Ok(_) => RenameResult {
                    old_path: old_rel,
                    new_path: new_rel,
                    ok: true,
                    error: None,
                },
                Err(e) => RenameResult {
                    old_path: old_rel,
                    new_path: new_rel,
                    ok: false,
                    error: Some(e.to_string()),
                },
            }
        };
        results.push(entry);
    }

    // Clean up directories emptied by the renames. Walk depth-first and remove
    // any dir whose only remaining contents were the files we moved out.
    fn remove_empty_dirs(dir: &std::path::Path, root: &std::path::Path) {
        if dir == root {
            return;
        }
        let rd = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut empty = true;
        let mut children: Vec<std::path::PathBuf> = Vec::new();
        for entry in rd.flatten() {
            // `file_type()` reports the entry itself; `path().is_dir()` would
            // follow a symlink, and this walk deletes what it finds empty — a
            // device carrying `Artist -> /somewhere/else` would send it out of
            // the root. A symlink counts as content, so its parent stays too.
            //
            // Inert today: the only caller passes `root` as `dir`, which the
            // guard above turns into an immediate return, so this walk has never
            // removed anything. Left correct rather than left to be discovered
            // by whoever makes it run — that belongs in its own change, not in
            // a containment fix.
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => children.push(entry.path()),
                _ => empty = false,
            }
        }
        for child in children {
            remove_empty_dirs(&child, root);
        }
        // Re-check after recursion cleared subdirs.
        let still_empty = std::fs::read_dir(dir)
            .map(|r| r.count() == 0)
            .unwrap_or(false);
        if empty && still_empty {
            let _ = std::fs::remove_dir(dir);
        }
    }
    remove_empty_dirs(root, root);

    results
}
