//! Local theme-package import.
//!
//! Reads a user-picked `.zip` and returns its `manifest.json`, `theme.css` and
//! any `assets/` files to the frontend, which runs the full theme-store contract
//! validation (`src/lib/themes/validateThemePackage.ts` + `themeAssets.ts`)
//! before installing.
//!
//! The thumbnail is not returned (the UI derives a swatch from the CSS). Parsing
//! the untrusted archive happens here in Rust, outside the webview, and every
//! read is size-capped so a malformed or hostile archive (lying header, zip-bomb,
//! path traversal) cannot exhaust memory or escape the archive. Asset extraction
//! additionally enforces the contract's extension whitelist and budgets; the
//! frontend re-validates (path containment, SVG content) before writing to disk.

use std::io::Read;

use serde::Serialize;

/// On-disk archive cap. Small — a theme with a couple of assets is well under this.
const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024;
/// Per-entry uncompressed caps — mirror the frontend/CI limits
/// (`validateThemeCss` caps CSS at 256 KB; the manifest is tiny).
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_CSS_BYTES: usize = 256 * 1024;
/// Asset budgets — mirror `themeAssets.ts` `ASSET_CAPS`.
const MAX_ASSET_FILE_BYTES: u64 = 1024 * 1024; // 1 MB
const MAX_ASSETS_TOTAL_BYTES: u64 = 4 * 1024 * 1024; // 4 MB
const MAX_ASSET_FILES: usize = 32;
/// Allowed asset extensions — mirror `themeAssets.ts` `ASSET_EXTS`.
const ASSET_EXTS: &[&str] = &[
    "webp", "png", "jpg", "jpeg", "gif", "avif", "svg", "woff2", "woff",
];

#[derive(Serialize, specta::Type, Debug)]
pub struct ImportedThemeAsset {
    /// Theme-relative path, forward-slashed, e.g. `assets/logo.svg`.
    pub rel: String,
    /// Raw bytes. Assets are small (whitelisted images/fonts, ≤ 1 MB each), so a
    /// plain byte array over IPC is fine.
    pub bytes: Vec<u8>,
}

#[derive(Serialize, specta::Type)]
pub struct ImportedThemeFiles {
    pub manifest: String,
    pub css: String,
    pub assets: Vec<ImportedThemeAsset>,
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
    let assets = read_asset_entries(&mut archive)?;

    Ok(ImportedThemeFiles {
        manifest,
        css,
        assets,
    })
}

/// Read every file entry under `assets/` (at the archive root or under a single
/// wrapping folder). Rejects traversal, enforces the extension whitelist and the
/// per-file / total / count budgets. Bytes are read bounded so a lying header
/// cannot allocate past the cap.
fn read_asset_entries<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<Vec<ImportedThemeAsset>, String> {
    let mut assets = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("corrupt archive entry: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        // `enclosed_name()` is `None` for absolute paths or `..` traversal.
        let path = match entry.enclosed_name() {
            Some(p) => p,
            None => return Err("archive contains an unsafe path".to_string()),
        };
        // Normalize to the theme-relative `assets/…` form, tolerating a single
        // wrapping folder (`<name>/assets/…`).
        let rel = {
            let comps: Vec<String> = path
                .components()
                .filter_map(|c| c.as_os_str().to_str().map(|s| s.to_string()))
                .collect();
            match comps.iter().position(|c| c == "assets") {
                Some(idx) if idx + 1 < comps.len() => comps[idx..].join("/"),
                _ => continue, // not under assets/
            }
        };
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !ASSET_EXTS.contains(&ext.as_str()) {
            return Err(format!("asset \"{rel}\" has a disallowed type"));
        }
        if entry.size() > MAX_ASSET_FILE_BYTES {
            return Err(format!(
                "asset \"{rel}\" is too large (> {} KB)",
                MAX_ASSET_FILE_BYTES / 1024
            ));
        }
        if assets.len() >= MAX_ASSET_FILES {
            return Err(format!("archive has more than {MAX_ASSET_FILES} asset files"));
        }
        let mut buf = Vec::new();
        entry
            .by_ref()
            .take(MAX_ASSET_FILE_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read {rel}: {e}"))?;
        if buf.len() as u64 > MAX_ASSET_FILE_BYTES {
            return Err(format!(
                "asset \"{rel}\" is too large (> {} KB)",
                MAX_ASSET_FILE_BYTES / 1024
            ));
        }
        total += buf.len() as u64;
        if total > MAX_ASSETS_TOTAL_BYTES {
            return Err(format!(
                "assets exceed the total cap (> {} KB)",
                MAX_ASSETS_TOTAL_BYTES / 1024
            ));
        }
        assets.push(ImportedThemeAsset { rel, bytes: buf });
    }
    Ok(assets)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    /// Build an in-memory zip from `(name, bytes)` entries.
    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default();
            for (name, bytes) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(bytes).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    fn assets_of(entries: &[(&str, &[u8])]) -> Result<Vec<ImportedThemeAsset>, String> {
        let buf = make_zip(entries);
        let mut archive = zip::ZipArchive::new(Cursor::new(buf)).unwrap();
        read_asset_entries(&mut archive)
    }

    #[test]
    fn extracts_assets_and_ignores_other_files() {
        let got = assets_of(&[
            ("manifest.json", b"{}"),
            ("theme.css", b"body{}"),
            ("assets/logo.svg", b"<svg/>"),
            ("assets/fonts/x.woff2", b"font"),
        ])
        .unwrap();
        let rels: Vec<_> = got.iter().map(|a| a.rel.as_str()).collect();
        assert!(rels.contains(&"assets/logo.svg"));
        assert!(rels.contains(&"assets/fonts/x.woff2"));
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn tolerates_a_single_wrapping_folder() {
        let got = assets_of(&[("bloodmoon/assets/logo.svg", b"<svg/>")]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].rel, "assets/logo.svg");
    }

    #[test]
    fn rejects_a_disallowed_extension() {
        let err = assets_of(&[("assets/evil.exe", b"MZ")]).unwrap_err();
        assert!(err.contains("disallowed type"), "{err}");
    }

    #[test]
    fn rejects_a_file_over_the_per_file_cap() {
        let big = vec![0u8; (MAX_ASSET_FILE_BYTES + 1) as usize];
        let err = assets_of(&[("assets/big.png", &big)]).unwrap_err();
        assert!(err.contains("too large"), "{err}");
    }

    #[test]
    fn a_theme_without_assets_yields_an_empty_list() {
        let got = assets_of(&[("manifest.json", b"{}"), ("theme.css", b"body{}")]).unwrap();
        assert!(got.is_empty());
    }
}
