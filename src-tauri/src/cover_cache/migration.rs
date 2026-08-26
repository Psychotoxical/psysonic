use std::path::Path;

use psysonic_core::cover_cache_layout::{cover_server_dir, sanitize_path_segment, SEGMENT_KINDS};
use psysonic_core::navidrome_id_codec::{
    canonical_artwork_id, canonical_id, is_lossless_legacy_id,
};

use super::bucket::merge_cover_bucket;

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheNavidromeMigrationDto {
    pub directories_scanned: u64,
    pub directories_moved: u64,
    pub directories_merged: u64,
}

pub(super) fn migrate_server_cover_ids(
    root: &Path,
    server_index_key: &str,
) -> Result<CoverCacheNavidromeMigrationDto, String> {
    if server_index_key.trim().is_empty() {
        return Err("cover migration server index key must not be empty".to_string());
    }
    let server_dir = cover_server_dir(root, server_index_key);
    let mut result = CoverCacheNavidromeMigrationDto::default();
    for kind in SEGMENT_KINDS {
        let kind_dir = server_dir.join(kind);
        let Ok(entries) = std::fs::read_dir(&kind_dir) else {
            continue;
        };
        let entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        for entry in entries {
            let source = entry.path();
            if !source.is_dir() {
                continue;
            }
            let old_name = entry
                .file_name()
                .into_string()
                .map_err(|_| "cover migration found a non-UTF-8 entity directory".to_string())?;
            result.directories_scanned = result.directories_scanned.saturating_add(1);
            let (new_name, lossless) = canonical_disk_entity_name(&old_name);
            if new_name == old_name {
                continue;
            }
            let destination = kind_dir.join(new_name);
            if !destination.exists() {
                std::fs::rename(&source, &destination).map_err(|error| error.to_string())?;
                result.directories_moved = result.directories_moved.saturating_add(1);
                continue;
            }
            if !lossless {
                return Err(format!(
                    "unproven Navidrome cover collision `{}` -> `{}`",
                    source.display(),
                    destination.display()
                ));
            }
            merge_cover_bucket(&source, &destination)?;
            std::fs::remove_dir_all(&source).map_err(|error| error.to_string())?;
            result.directories_merged = result.directories_merged.saturating_add(1);
        }
    }
    Ok(result)
}

pub(super) fn verify_server_cover_ids(root: &Path, server_index_key: &str) -> Result<(), String> {
    if server_index_key.trim().is_empty() {
        return Err("cover verification server index key must not be empty".to_string());
    }
    let server_dir = cover_server_dir(root, server_index_key);
    for kind in SEGMENT_KINDS {
        let kind_dir = server_dir.join(kind);
        let Ok(entries) = std::fs::read_dir(&kind_dir) else {
            continue;
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.path().is_dir() {
                continue;
            }
            let old_name = entry
                .file_name()
                .into_string()
                .map_err(|_| {
                    "cover verification found a non-UTF-8 entity directory".to_string()
                })?;
            if canonical_disk_entity_name(&old_name).0 != old_name {
                return Err(format!(
                    "Navidrome cover migration residue in `{}`",
                    entry.path().display()
                ));
            }
        }
    }
    Ok(())
}

fn canonical_disk_entity_name(value: &str) -> (String, bool) {
    let logical = restore_disc_separator(value);
    let canonical = canonical_artwork_id(&logical);
    let lossless = artwork_payload(&logical)
        .map(is_lossless_legacy_id)
        .unwrap_or_else(|| is_lossless_legacy_id(&logical));
    (sanitize_path_segment(&canonical), lossless)
}

fn restore_disc_separator(value: &str) -> String {
    let Some(payload) = value.strip_prefix("dc-") else {
        return value.to_string();
    };
    for id_len in [36usize, 32, 22] {
        if payload.len() > id_len && payload.as_bytes().get(id_len) == Some(&b'_') {
            let id = &payload[..id_len];
            if canonical_id(id) != id || is_lossless_legacy_id(id) {
                return format!("dc-{id}:{}", &payload[id_len + 1..]);
            }
        }
    }
    value.to_string()
}

fn artwork_payload(value: &str) -> Option<&str> {
    let payload = ["mf-", "al-", "ar-", "pl-", "ra-", "tr-", "dc-"]
        .into_iter()
        .find_map(|prefix| value.strip_prefix(prefix))?;
    let payload = payload.rsplit_once('_').map(|(head, _)| head).unwrap_or(payload);
    Some(payload.split_once(':').map(|(id, _)| id).unwrap_or(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cover_cache::test_support::fresh_tmpdir;

    const LEGACY_TRACK: &str = "e3b7fc2ae9447bbec37a13bf916e3cf6";
    const CANONICAL_TRACK: &str = "6VHl3uR4kss6sUPKA8Cwnk";

    #[test]
    fn parsed_names_preserve_prefixes_tokens_and_disc_suffixes() {
        assert_eq!(
            canonical_disk_entity_name(&format!("al-{LEGACY_TRACK}_60fc987f")).0,
            format!("al-{CANONICAL_TRACK}_60fc987f")
        );
        assert_eq!(
            canonical_disk_entity_name(&format!("dc-{LEGACY_TRACK}_2_60fc987f")).0,
            format!("dc-{CANONICAL_TRACK}_2_60fc987f")
        );
    }

    #[test]
    fn migration_merges_only_missing_destination_files() {
        let temp = fresh_tmpdir("canonical-id-migration");
        let kind = cover_server_dir(&temp, "s1").join("album");
        let source = kind.join(LEGACY_TRACK);
        let destination = kind.join(CANONICAL_TRACK);
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("128.webp"), b"source-128").unwrap();
        std::fs::write(source.join("800.webp"), b"source-800").unwrap();
        std::fs::write(destination.join("128.webp"), b"destination-128").unwrap();

        let result = migrate_server_cover_ids(&temp, "s1").unwrap();
        assert_eq!(result.directories_merged, 1);
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(destination.join("128.webp")).unwrap(),
            b"destination-128"
        );
        assert_eq!(
            std::fs::read(destination.join("800.webp")).unwrap(),
            b"source-800"
        );
        let _ = std::fs::remove_dir_all(temp);
    }
}
