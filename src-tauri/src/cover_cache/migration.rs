use std::cmp::Ordering;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use psysonic_core::cover_cache_layout::{cover_server_dir, sanitize_path_segment, SEGMENT_KINDS};
use psysonic_core::navidrome_id_codec::{
    canonical_artwork_id, canonical_id, is_lossless_legacy_id,
};

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
        let entries = entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
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
            merge_cover_migration_bucket(&source, &destination)?;
            std::fs::remove_dir_all(&source).map_err(|error| error.to_string())?;
            result.directories_merged = result.directories_merged.saturating_add(1);
        }
    }
    Ok(result)
}

fn merge_cover_migration_bucket(source_dir: &Path, destination_dir: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(source_dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let destination = destination_dir.join(entry.file_name());
        if source.is_dir() {
            if destination.is_file() {
                return Err(format!(
                    "cover migration type collision `{}` -> `{}`",
                    source.display(),
                    destination.display()
                ));
            }
            std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            merge_cover_migration_bucket(&source, &destination)?;
            continue;
        }
        if destination.is_dir() {
            return Err(format!(
                "cover migration type collision `{}` -> `{}`",
                source.display(),
                destination.display()
            ));
        }

        recover_interrupted_replacement(&destination)?;
        if !destination.exists() {
            std::fs::rename(&source, &destination).map_err(|error| error.to_string())?;
        } else if source_file_preferred(&source, &destination)? {
            replace_file_recoverably(&source, &destination)?;
        }
    }
    Ok(())
}

#[derive(Debug)]
struct CoverArtifactMetadata {
    valid: bool,
    modified: Option<SystemTime>,
    len: u64,
}

fn cover_artifact_metadata(path: &Path) -> Result<CoverArtifactMetadata, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let len = metadata.len();
    let valid = if path.extension().and_then(|extension| extension.to_str()) == Some("webp") {
        len > 0 && image::open(path).is_ok()
    } else if path.file_name().and_then(|name| name.to_str()) == Some("meta.json") {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some()
    } else {
        len > 0
    };
    Ok(CoverArtifactMetadata {
        valid,
        modified: metadata.modified().ok(),
        len,
    })
}

fn source_file_preferred(source: &Path, destination: &Path) -> Result<bool, String> {
    let source = cover_artifact_metadata(source)?;
    let destination = cover_artifact_metadata(destination)?;
    Ok(match source.valid.cmp(&destination.valid) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => match (source.modified, destination.modified) {
            (Some(source), Some(destination)) if source != destination => source > destination,
            _ => source.len > destination.len,
        },
    })
}

fn replacement_sibling(destination: &Path, suffix: &str) -> Result<PathBuf, String> {
    let file_name = destination.file_name().ok_or_else(|| {
        format!(
            "cover migration destination has no filename: {}",
            destination.display()
        )
    })?;
    let mut sibling_name = OsString::from(".");
    sibling_name.push(file_name);
    sibling_name.push(suffix);
    Ok(destination.with_file_name(sibling_name))
}

fn recover_interrupted_replacement(destination: &Path) -> Result<(), String> {
    let temporary = replacement_sibling(destination, ".canonical-migration.tmp")?;
    let backup = replacement_sibling(destination, ".canonical-migration.backup")?;
    if backup.exists() {
        if destination.exists() {
            std::fs::remove_file(&backup).map_err(|error| error.to_string())?;
        } else {
            std::fs::rename(&backup, destination).map_err(|error| error.to_string())?;
        }
    }
    if temporary.exists() {
        std::fs::remove_file(temporary).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn replace_file_recoverably(source: &Path, destination: &Path) -> Result<(), String> {
    let temporary = replacement_sibling(destination, ".canonical-migration.tmp")?;
    let backup = replacement_sibling(destination, ".canonical-migration.backup")?;
    std::fs::copy(source, &temporary).map_err(|error| error.to_string())?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    std::fs::rename(destination, &backup).map_err(|error| error.to_string())?;
    if let Err(error) = std::fs::rename(&temporary, destination) {
        let rollback = std::fs::rename(&backup, destination);
        return match rollback {
            Ok(()) => Err(error.to_string()),
            Err(rollback_error) => Err(format!(
                "cover migration replacement failed: {error}; rollback failed: {rollback_error}"
            )),
        };
    }
    std::fs::remove_file(&backup).map_err(|error| error.to_string())?;
    Ok(())
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
                .map_err(|_| "cover verification found a non-UTF-8 entity directory".to_string())?;
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
    let payload = payload
        .rsplit_once('_')
        .map(|(head, _)| head)
        .unwrap_or(payload);
    Some(payload.split_once(':').map(|(id, _)| id).unwrap_or(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cover_cache::encode::encode_webp;
    use crate::cover_cache::test_support::fresh_tmpdir;
    use image::DynamicImage;
    use std::fs::{File, FileTimes, OpenOptions};
    use std::time::{Duration, UNIX_EPOCH};

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

    fn write_valid_webp(path: &Path, shade: u8) {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            2,
            2,
            image::Rgba([shade, shade, shade, 255]),
        ));
        std::fs::write(path, encode_webp(&image, 128).unwrap()).unwrap();
    }

    fn set_modified(path: &Path, seconds: u64) {
        let file: File = OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)))
            .unwrap();
    }

    fn collision_dirs(temp: &Path) -> (PathBuf, PathBuf) {
        let kind = cover_server_dir(temp, "s1").join("album");
        let source = kind.join(LEGACY_TRACK);
        let destination = kind.join(CANONICAL_TRACK);
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        (source, destination)
    }

    #[test]
    fn migration_keeps_newer_valid_destination_and_moves_missing_tiers() {
        let temp = fresh_tmpdir("canonical-id-migration");
        let (source, destination) = collision_dirs(&temp);
        write_valid_webp(&source.join("128.webp"), 10);
        write_valid_webp(&source.join("800.webp"), 20);
        write_valid_webp(&destination.join("128.webp"), 30);
        set_modified(&source.join("128.webp"), 100);
        set_modified(&destination.join("128.webp"), 200);
        let destination_128 = std::fs::read(destination.join("128.webp")).unwrap();
        let source_800 = std::fs::read(source.join("800.webp")).unwrap();

        let result = migrate_server_cover_ids(&temp, "s1").unwrap();
        assert_eq!(result.directories_merged, 1);
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(destination.join("128.webp")).unwrap(),
            destination_128
        );
        assert_eq!(
            std::fs::read(destination.join("800.webp")).unwrap(),
            source_800
        );
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn migration_replaces_older_valid_destination_with_newer_valid_source() {
        let temp = fresh_tmpdir("canonical-id-migration-newer-source");
        let (source, destination) = collision_dirs(&temp);
        write_valid_webp(&source.join("128.webp"), 10);
        write_valid_webp(&destination.join("128.webp"), 30);
        set_modified(&destination.join("128.webp"), 100);
        set_modified(&source.join("128.webp"), 200);
        let source_bytes = std::fs::read(source.join("128.webp")).unwrap();

        migrate_server_cover_ids(&temp, "s1").unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(destination.join("128.webp")).unwrap(),
            source_bytes
        );
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn migration_keeps_decodable_destination_when_newer_source_webp_is_truncated() {
        let temp = fresh_tmpdir("canonical-id-migration-truncated-source");
        let (source, destination) = collision_dirs(&temp);
        write_valid_webp(&source.join("128.webp"), 10);
        write_valid_webp(&destination.join("128.webp"), 30);
        let source_path = source.join("128.webp");
        let destination_path = destination.join("128.webp");
        let mut truncated_source = std::fs::read(&source_path).unwrap();
        truncated_source.truncate(truncated_source.len() - 8);
        std::fs::write(&source_path, &truncated_source).unwrap();
        set_modified(&destination_path, 100);
        set_modified(&source_path, 200);
        let destination_bytes = std::fs::read(&destination_path).unwrap();

        assert!(image::image_dimensions(&source_path).is_ok());
        assert!(image::open(&source_path).is_err());

        migrate_server_cover_ids(&temp, "s1").unwrap();

        assert!(!source.exists());
        assert_eq!(std::fs::read(destination_path).unwrap(), destination_bytes);
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn migration_replaces_empty_or_invalid_destination_with_valid_source() {
        for (case, destination_bytes) in [("empty", Vec::new()), ("invalid", b"not-webp".to_vec())]
        {
            let temp = fresh_tmpdir(&format!("canonical-id-migration-{case}"));
            let (source, destination) = collision_dirs(&temp);
            write_valid_webp(&source.join("128.webp"), 10);
            std::fs::write(destination.join("128.webp"), destination_bytes).unwrap();
            set_modified(&source.join("128.webp"), 100);
            set_modified(&destination.join("128.webp"), 200);
            let source_bytes = std::fs::read(source.join("128.webp")).unwrap();

            migrate_server_cover_ids(&temp, "s1").unwrap();

            assert_eq!(
                std::fs::read(destination.join("128.webp")).unwrap(),
                source_bytes
            );
            let _ = std::fs::remove_dir_all(temp);
        }
    }

    #[test]
    fn migration_uses_freshness_for_metadata_collisions() {
        let temp = fresh_tmpdir("canonical-id-migration-metadata");
        let (source, destination) = collision_dirs(&temp);
        std::fs::write(source.join(".fetch-failed"), b"source-marker").unwrap();
        std::fs::write(destination.join(".fetch-failed"), b"destination-marker").unwrap();
        set_modified(&destination.join(".fetch-failed"), 100);
        set_modified(&source.join(".fetch-failed"), 200);

        migrate_server_cover_ids(&temp, "s1").unwrap();

        assert_eq!(
            std::fs::read(destination.join(".fetch-failed")).unwrap(),
            b"source-marker"
        );
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn migration_recovers_interrupted_replacement_before_retrying() {
        let temp = fresh_tmpdir("canonical-id-migration-recovery");
        let (source, destination) = collision_dirs(&temp);
        write_valid_webp(&source.join("128.webp"), 10);
        write_valid_webp(&destination.join("128.webp"), 30);
        set_modified(&destination.join("128.webp"), 100);
        set_modified(&source.join("128.webp"), 200);
        let backup =
            replacement_sibling(&destination.join("128.webp"), ".canonical-migration.backup")
                .unwrap();
        std::fs::rename(destination.join("128.webp"), &backup).unwrap();
        std::fs::write(
            replacement_sibling(&destination.join("128.webp"), ".canonical-migration.tmp").unwrap(),
            b"partial",
        )
        .unwrap();
        let source_bytes = std::fs::read(source.join("128.webp")).unwrap();

        migrate_server_cover_ids(&temp, "s1").unwrap();

        assert_eq!(
            std::fs::read(destination.join("128.webp")).unwrap(),
            source_bytes
        );
        assert!(!backup.exists());
        let _ = std::fs::remove_dir_all(temp);
    }
}
