use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const DOWNLOAD_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
const DOWNLOAD_RESERVATION_WINDOW_BYTES: u64 = 64 * 1024 * 1024;
static RESERVED_DOWNLOAD_BYTES: OnceLock<Mutex<HashMap<FilesystemId, u64>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum FilesystemId {
    #[cfg(unix)]
    Device(u64),
    #[cfg(windows)]
    Volume(u32),
}

pub(super) struct DownloadSpaceReservation {
    filesystem_id: FilesystemId,
    remaining: u64,
}

impl DownloadSpaceReservation {
    pub(super) async fn ensure_capacity(
        &mut self,
        part_path: &Path,
        needed: u64,
        maximum_remaining: u64,
    ) -> Result<(), String> {
        if self.remaining >= needed {
            return Ok(());
        }
        let target = download_reservation_target(needed, maximum_remaining);
        let additional = target.saturating_sub(self.remaining);
        if additional == 0 {
            return Ok(());
        }
        reserve_download_space_bytes(part_path, Some(self.filesystem_id), additional).await?;
        self.remaining = self.remaining.saturating_add(additional);
        Ok(())
    }

    pub(super) fn consume(&mut self, bytes: u64) {
        let consumed = bytes.min(self.remaining);
        self.remaining -= consumed;
        release_on_filesystem(self.filesystem_id, consumed);
    }
}

impl Drop for DownloadSpaceReservation {
    fn drop(&mut self) {
        release_on_filesystem(self.filesystem_id, self.remaining);
    }
}

fn download_reservation_target(needed: u64, maximum_remaining: u64) -> u64 {
    maximum_remaining
        .min(DOWNLOAD_RESERVATION_WINDOW_BYTES)
        .max(needed)
}

#[cfg(unix)]
fn filesystem_id(path: &Path) -> std::io::Result<FilesystemId> {
    use std::os::unix::fs::MetadataExt;

    std::fs::metadata(path).map(|metadata| FilesystemId::Device(metadata.dev()))
}

#[cfg(windows)]
fn filesystem_id(path: &Path) -> std::io::Result<FilesystemId> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetVolumeInformationW, GetVolumePathNameW};

    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut volume_path = vec![0u16; 32_768];
    if unsafe {
        GetVolumePathNameW(
            path_wide.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let mut serial = 0u32;
    if unsafe {
        GetVolumeInformationW(
            volume_path.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(FilesystemId::Volume(serial))
}

fn disk_space_for_path(path: &Path) -> Result<(FilesystemId, u64), String> {
    let directory = path.parent().unwrap_or(path);
    let filesystem_id = filesystem_id(directory)
        .map_err(|error| format!("could not identify download filesystem: {error}"))?;
    let available = fs4::available_space(directory)
        .map_err(|error| format!("could not query free disk space for download: {error}"))?;
    Ok((filesystem_id, available))
}

fn reservations() -> &'static Mutex<HashMap<FilesystemId, u64>> {
    RESERVED_DOWNLOAD_BYTES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reserve_in_map(
    reservations: &mut HashMap<FilesystemId, u64>,
    filesystem_id: FilesystemId,
    additional_bytes: u64,
    available: u64,
) -> Result<(), String> {
    if additional_bytes == 0 {
        return Ok(());
    }
    let reserved = reservations.get(&filesystem_id).copied().unwrap_or(0);
    if reserved
        .saturating_add(additional_bytes)
        .saturating_add(DOWNLOAD_DISK_RESERVE_BYTES)
        > available
    {
        return Err("not enough free disk space for download".to_string());
    }
    reservations.insert(filesystem_id, reserved.saturating_add(additional_bytes));
    Ok(())
}

async fn reserve_download_space_bytes(
    part_path: &Path,
    expected_filesystem_id: Option<FilesystemId>,
    additional_bytes: u64,
) -> Result<FilesystemId, String> {
    let path = PathBuf::from(part_path);
    let (filesystem_id, available) =
        tokio::task::spawn_blocking(move || disk_space_for_path(&path))
            .await
            .map_err(|error| format!("disk-space task failed: {error}"))??;
    if expected_filesystem_id.is_some_and(|expected| expected != filesystem_id) {
        return Err("download destination filesystem changed".to_string());
    }
    let mut reservations = reservations()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    reserve_in_map(
        &mut reservations,
        filesystem_id,
        additional_bytes,
        available,
    )?;
    Ok(filesystem_id)
}

fn release_on_filesystem(filesystem_id: FilesystemId, bytes: u64) {
    if bytes == 0 {
        return;
    }
    let mut reservations = reservations()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let remaining = reservations
        .get(&filesystem_id)
        .copied()
        .unwrap_or(0)
        .saturating_sub(bytes);
    if remaining == 0 {
        reservations.remove(&filesystem_id);
    } else {
        reservations.insert(filesystem_id, remaining);
    }
}

pub(super) async fn reserve_download_space(
    part_path: &Path,
    maximum_remaining: u64,
) -> Result<DownloadSpaceReservation, String> {
    let initial = maximum_remaining.min(DOWNLOAD_RESERVATION_WINDOW_BYTES);
    let filesystem_id = reserve_download_space_bytes(part_path, None, initial).await?;
    Ok(DownloadSpaceReservation {
        filesystem_id,
        remaining: initial,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn test_filesystem_id(value: u32) -> FilesystemId {
        FilesystemId::Device(u64::from(value))
    }

    #[cfg(windows)]
    fn test_filesystem_id(value: u32) -> FilesystemId {
        FilesystemId::Volume(value)
    }

    #[test]
    fn reservations_are_isolated_per_filesystem() {
        let first = test_filesystem_id(std::process::id());
        let second = test_filesystem_id(std::process::id().saturating_add(1));
        let available = DOWNLOAD_DISK_RESERVE_BYTES + 100;
        let mut reserved = HashMap::new();

        reserve_in_map(&mut reserved, first, 80, available).unwrap();
        assert!(reserve_in_map(&mut reserved, first, 30, available).is_err());
        reserve_in_map(&mut reserved, second, 80, available).unwrap();
    }

    #[test]
    fn consumed_space_is_released() {
        let filesystem_id = test_filesystem_id(std::process::id().saturating_add(2));
        reservations()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(filesystem_id, 64);
        let mut reservation = DownloadSpaceReservation {
            filesystem_id,
            remaining: 64,
        };

        reservation.consume(24);
        assert_eq!(
            reservations()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(&filesystem_id),
            Some(&40)
        );
        drop(reservation);
        assert!(!reservations()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&filesystem_id));
    }

    #[test]
    fn final_window_uses_only_known_remainder() {
        let remainder = 6 * 1024 * 1024;
        assert_eq!(download_reservation_target(64 * 1024, remainder), remainder);
    }
}
