use std::io::Write;
use std::sync::{Mutex, OnceLock};

use super::planned_path_stays_within;

pub(super) struct DeviceManifestWrite {
    pub(super) dest_dir: String,
    pub(super) owner_server_index_key: String,
    pub(super) sources: serde_json::Value,
    pub(super) canonical_id_version: Option<u8>,
    pub(super) layout_mode: Option<String>,
    pub(super) playlist_path_mode: Option<String>,
    pub(super) files: Option<serde_json::Value>,
    pub(super) playlists: Option<serde_json::Value>,
}

pub fn write_device_manifest_for_migration(
    dest_dir: String,
    owner_server_index_key: String,
    sources: serde_json::Value,
    canonical_id_version: Option<u8>,
) -> Result<(), String> {
    let previous = read_device_manifest(dest_dir.clone());
    let previous_owner = previous
        .as_ref()
        .and_then(|value| value.get("ownerServerIndexKey"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    crate::sync::batch::plan::canonicalize_device_sync_plan(
        std::path::Path::new(&dest_dir),
        previous_owner.as_deref(),
        &owner_server_index_key,
    )?;
    let files = previous
        .as_ref()
        .and_then(|value| value.get("files"))
        .cloned()
        .map(|mut files| {
            canonicalize_manifest_files(
                &mut files,
                previous_owner.as_deref(),
                &owner_server_index_key,
            );
            files
        });
    let playlists = previous
        .as_ref()
        .and_then(|value| value.get("playlists"))
        .cloned()
        .map(|mut playlists| {
            canonicalize_manifest_playlists(
                &mut playlists,
                previous_owner.as_deref(),
                &owner_server_index_key,
            );
            playlists
        });
    write_device_manifest_payload(DeviceManifestWrite {
        dest_dir,
        owner_server_index_key,
        sources,
        canonical_id_version,
        layout_mode: None,
        playlist_path_mode: None,
        files,
        playlists,
    })
}

fn canonicalize_source_key(
    value: &str,
    previous_owner_server_index_key: Option<&str>,
    owner_server_index_key: &str,
) -> String {
    let Ok((server, source_type, id)) = serde_json::from_str::<(String, String, String)>(value)
    else {
        return value.to_string();
    };
    if server != owner_server_index_key && previous_owner_server_index_key != Some(server.as_str())
    {
        return value.to_string();
    }
    serde_json::to_string(&(
        owner_server_index_key,
        source_type,
        psysonic_core::navidrome_id_codec::canonical_id(&id),
    ))
    .unwrap_or_else(|_| value.to_string())
}

fn canonicalize_manifest_files(
    files: &mut serde_json::Value,
    previous_owner_server_index_key: Option<&str>,
    owner_server_index_key: &str,
) {
    let Some(files) = files.as_array_mut() else {
        return;
    };
    for file in files {
        let Some(file) = file.as_object_mut() else {
            continue;
        };
        if let Some(track_id) = file
            .get("trackId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
        {
            file["trackId"] =
                serde_json::json!(psysonic_core::navidrome_id_codec::canonical_id(&track_id));
        }
        if let Some(source_keys) = file
            .get_mut("sourceKeys")
            .and_then(serde_json::Value::as_array_mut)
        {
            for source_key in source_keys {
                if let Some(value) = source_key.as_str().map(str::to_string) {
                    *source_key = serde_json::json!(canonicalize_source_key(
                        &value,
                        previous_owner_server_index_key,
                        owner_server_index_key
                    ));
                }
            }
        }
    }
}

fn canonicalize_manifest_playlists(
    playlists: &mut serde_json::Value,
    previous_owner_server_index_key: Option<&str>,
    owner_server_index_key: &str,
) {
    let Some(playlists) = playlists.as_array_mut() else {
        return;
    };
    for playlist in playlists {
        let Some(source_key) = playlist
            .get("sourceKey")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        playlist["sourceKey"] = serde_json::json!(canonicalize_source_key(
            &source_key,
            previous_owner_server_index_key,
            owner_server_index_key
        ));
    }
}

pub(super) fn write_device_manifest_payload(input: DeviceManifestWrite) -> Result<(), String> {
    let DeviceManifestWrite {
        dest_dir,
        owner_server_index_key,
        sources,
        canonical_id_version,
        layout_mode,
        playlist_path_mode,
        files,
        playlists,
    } = input;
    if owner_server_index_key.trim().is_empty() {
        return Err("DEVICE_SYNC_SERVER_OWNER_MISSING".to_string());
    }
    let source_list = sources
        .as_array()
        .ok_or_else(|| "DEVICE_SYNC_SOURCES_INVALID".to_string())?;
    if source_list.iter().any(|source| {
        source
            .get("serverIndexKey")
            .and_then(|value| value.as_str())
            != Some(owner_server_index_key.as_str())
    }) {
        return Err("DEVICE_SYNC_SERVER_OWNER_MISMATCH".to_string());
    }
    let root = std::path::Path::new(&dest_dir);
    let path = root.join("psysonic-sync.json");
    let previous = std::fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok());
    let layout_mode = layout_mode
        .or_else(|| {
            previous
                .as_ref()
                .and_then(|value| value.get("layoutMode"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "self-contained".to_string());
    if layout_mode != "self-contained" && layout_mode != "shared-album-tree" {
        return Err("DEVICE_SYNC_LAYOUT_MODE_INVALID".to_string());
    }
    let playlist_path_mode = playlist_path_mode
        .or_else(|| {
            previous
                .as_ref()
                .and_then(|value| value.get("playlistPathMode"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "playlist-relative".to_string());
    if playlist_path_mode != "playlist-relative" && playlist_path_mode != "device-rooted" {
        return Err("DEVICE_SYNC_PLAYLIST_PATH_MODE_INVALID".to_string());
    }
    let files = files.or_else(|| {
        previous
            .as_ref()
            .and_then(|value| value.get("files"))
            .cloned()
    });
    let playlists = playlists.or_else(|| {
        previous
            .as_ref()
            .and_then(|value| value.get("playlists"))
            .cloned()
    });
    if files.as_ref().is_some_and(|value| !value.is_array())
        || playlists.as_ref().is_some_and(|value| !value.is_array())
        || files.is_some() != playlists.is_some()
    {
        return Err("DEVICE_SYNC_MANIFEST_PLAN_INVALID".to_string());
    }

    let mut payload = serde_json::json!({
        "version": 4,
        "schema": "fixed-v2",
        "ownerServerIndexKey": owner_server_index_key,
        "sources": sources,
        "layoutMode": layout_mode,
        "playlistPathMode": playlist_path_mode,
    });
    if let (Some(files), Some(playlists)) = (files, playlists) {
        payload["files"] = files;
        payload["playlists"] = playlists;
    }
    if let Some(version) = canonical_id_version {
        payload["canonicalIdVersion"] = serde_json::json!(version);
    }
    let json = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    replace_device_text_file(root, &path, json.as_bytes())
}

fn device_metadata_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(super) fn device_metadata_temp_counter() -> &'static std::sync::atomic::AtomicU64 {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    &COUNTER
}

pub(crate) fn replace_device_text_file(
    root: &std::path::Path,
    path: &std::path::Path,
    contents: &[u8],
) -> Result<(), String> {
    if !root.is_dir() {
        return Err("VOLUME_NOT_FOUND".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "DEVICE_SYNC_PATH_INVALID".to_string())?;
    match planned_path_stays_within(root, path) {
        Ok(true) => {}
        Ok(false) => return Err("DEVICE_SYNC_PATH_ESCAPES_ROOT".to_string()),
        Err(error) => return Err(error.to_string()),
    }
    if super::path_contains_symlink(root, path)? {
        return Err("DEVICE_SYNC_PATH_INVALID".to_string());
    }

    let _write_guard = device_metadata_write_lock()
        .lock()
        .map_err(|_| "device metadata write lock poisoned".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    match planned_path_stays_within(root, path) {
        Ok(true) => {}
        Ok(false) => return Err("DEVICE_SYNC_PATH_ESCAPES_ROOT".to_string()),
        Err(error) => return Err(error.to_string()),
    }
    if super::path_contains_symlink(root, path)? {
        return Err("DEVICE_SYNC_PATH_INVALID".to_string());
    }

    let sequence =
        device_metadata_temp_counter().fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".psysonic-write.{}.{}.tmp",
        std::process::id(),
        sequence,
    ));
    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;

        atomic_replace_file(&temporary, path)?;
        sync_device_directory(Some(parent))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(not(windows))]
fn atomic_replace_file(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn atomic_replace_file(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "MoveFileExW"]
        fn move_file_ex_w(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both pointers reference live, NUL-terminated UTF-16 buffers for this call.
    let moved = unsafe {
        move_file_ex_w(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn sync_device_directory(parent: Option<&std::path::Path>) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(parent) = parent {
        let directory = std::fs::File::open(parent).map_err(|error| error.to_string())?;
        directory.sync_all().map_err(|error| error.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

pub(super) fn read_device_manifest(dest_dir: String) -> Option<serde_json::Value> {
    let path = std::path::Path::new(&dest_dir).join("psysonic-sync.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}
