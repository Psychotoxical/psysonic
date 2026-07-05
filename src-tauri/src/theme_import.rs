//! Local theme-package import.
//!
//! Reads a user-picked `.zip` and returns its `manifest.json` + `theme.css`
//! to the frontend, which runs the full theme-store contract validation
//! (`src/utils/themes/validateThemePackage.ts`) before installing.
//!
//! Only those two entries are pulled out — the thumbnail is not needed (the UI
//! derives a swatch from the CSS). Parsing the untrusted archive happens here
//! in Rust, outside the webview, and every read is size-capped so a malformed
//! or hostile archive (lying header, zip-bomb, path traversal) cannot exhaust
//! memory or escape the archive.

use std::io::Read;

use serde::Serialize;

/// On-disk archive cap. A real token-only theme zip is a few KB.
const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024;
/// Per-entry uncompressed caps — mirror the frontend/CI limits
/// (`validateThemeCss` caps CSS at 64 KB; the manifest is tiny).
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_CSS_BYTES: usize = 256 * 1024;

#[derive(Serialize, specta::Type)]
pub struct ImportedThemeFiles {
    pub manifest: String,
    pub css: String,
}

#[tauri::command]
#[specta::specta]
pub fn import_theme_zip(path: String) -> Result<ImportedThemeFiles, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("cannot open file: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("cannot read file info: {e}"))?
        .len();
    if len > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "archive is too large (> {} KB)",
            MAX_ARCHIVE_BYTES / 1024
        ));
    }

    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| "not a valid .zip archive".to_string())?;

    let manifest = read_capped_entry(&mut archive, "manifest.json", MAX_MANIFEST_BYTES)?
        .ok_or_else(|| "manifest.json was not found in the archive".to_string())?;
    let css = read_capped_entry(&mut archive, "theme.css", MAX_CSS_BYTES)?
        .ok_or_else(|| "theme.css was not found in the archive".to_string())?;

    Ok(ImportedThemeFiles { manifest, css })
}

/// Find the first non-directory entry whose file name equals `wanted` (at the
/// archive root or under a single wrapping folder), reject path traversal, and
/// read it as UTF-8 text under `cap` bytes. Both the declared size and the
/// actual read are bounded, so a lying header cannot allocate past the cap.
fn read_capped_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    wanted: &str,
    cap: usize,
) -> Result<Option<String>, String> {
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("corrupt archive entry: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        // `enclosed_name()` is `None` for absolute paths or `..` traversal.
        let base = match entry.enclosed_name() {
            Some(p) => match p.file_name().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            },
            None => return Err("archive contains an unsafe path".to_string()),
        };
        if base != wanted {
            continue;
        }
        if entry.size() > cap as u64 {
            return Err(format!("{wanted} is too large (> {} KB)", cap / 1024));
        }
        let mut buf = Vec::new();
        entry
            .by_ref()
            .take(cap as u64 + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read {wanted}: {e}"))?;
        if buf.len() > cap {
            return Err(format!("{wanted} is too large (> {} KB)", cap / 1024));
        }
        return String::from_utf8(buf)
            .map(Some)
            .map_err(|_| format!("{wanted} is not valid UTF-8"));
    }
    Ok(None)
}
