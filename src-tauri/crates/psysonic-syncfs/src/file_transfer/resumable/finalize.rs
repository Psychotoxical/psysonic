use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use super::{remove_partial_download, resume_metadata_path, ResumableDownloadResponse};
use crate::file_transfer::space::reserve_download_space;
use crate::file_transfer::{
    reqwest_error_without_url, wait_for_atomic_cancellation, DownloadCancellation,
};

enum CancellationMode<'a> {
    Atomic(&'a AtomicBool),
    Wakeable(&'a mut DownloadCancellation),
}

impl CancellationMode<'_> {
    fn is_cancelled(&self) -> bool {
        match self {
            Self::Atomic(flag) => flag.load(Ordering::Relaxed),
            Self::Wakeable(cancel) => cancel.is_cancelled(),
        }
    }

    async fn cancelled(&mut self) {
        match self {
            Self::Atomic(flag) => wait_for_atomic_cancellation(flag).await,
            Self::Wakeable(cancel) => cancel.cancelled().await,
        }
    }
}

pub async fn finalize_resumable_download(
    prepared: ResumableDownloadResponse,
    destination: &Path,
    part_path: &Path,
    max_bytes: u64,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    let mut cancellation = cancel.map(CancellationMode::Atomic);
    finalize_resumable_download_inner(
        prepared,
        destination,
        part_path,
        max_bytes,
        cancellation.as_mut(),
    )
    .await
}

pub async fn finalize_resumable_download_cancellable(
    prepared: ResumableDownloadResponse,
    destination: &Path,
    part_path: &Path,
    max_bytes: u64,
    cancellation: Option<&mut DownloadCancellation>,
) -> Result<(), String> {
    let mut cancellation = cancellation.map(CancellationMode::Wakeable);
    finalize_resumable_download_inner(
        prepared,
        destination,
        part_path,
        max_bytes,
        cancellation.as_mut(),
    )
    .await
}

async fn finalize_resumable_download_inner(
    prepared: ResumableDownloadResponse,
    destination: &Path,
    part_path: &Path,
    max_bytes: u64,
    mut cancellation: Option<&mut CancellationMode<'_>>,
) -> Result<(), String> {
    prepared.validate_status()?;
    let ResumableDownloadResponse {
        response,
        append,
        resumed_from,
        expected_total,
        resume_supported,
        completed_partial,
    } = prepared;
    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        remove_partial_download(part_path).await;
        return Err("CANCELLED".to_string());
    }
    if completed_partial {
        let actual_size = tokio::fs::metadata(part_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if actual_size == 0
            || actual_size != resumed_from
            || expected_total != Some(actual_size)
            || actual_size > max_bytes
        {
            remove_partial_download(part_path).await;
            return Err("completed partial changed before promotion".to_string());
        }
        tokio::fs::rename(part_path, destination)
            .await
            .map_err(|error| error.to_string())?;
        let _ = tokio::fs::remove_file(resume_metadata_path(part_path)).await;
        if cancellation
            .as_ref()
            .is_some_and(|cancel| cancel.is_cancelled())
        {
            let _ = tokio::fs::remove_file(destination).await;
            return Err("CANCELLED".to_string());
        }
        return Ok(());
    }
    if response
        .content_length()
        .is_some_and(|length| resumed_from.saturating_add(length) > max_bytes)
    {
        remove_partial_download(part_path).await;
        return Err("download exceeded the expected size limit".to_string());
    }
    let planned_size = expected_total.unwrap_or(max_bytes);
    let reserve = reserve_download_space(part_path, planned_size.saturating_sub(resumed_from));
    tokio::pin!(reserve);
    let reservation = if let Some(cancel) = cancellation.as_deref_mut() {
        tokio::select! {
            result = &mut reserve => result,
            _ = cancel.cancelled() => {
                remove_partial_download(part_path).await;
                return Err("CANCELLED".to_string());
            }
        }
    } else {
        reserve.await
    };
    let mut space_reservation = match reservation {
        Ok(reservation) => reservation,
        Err(error) => {
            if resumed_from == 0 {
                remove_partial_download(part_path).await;
            }
            return Err(error);
        }
    };

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if append {
        let actual_size = tokio::fs::metadata(part_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if actual_size != resumed_from {
            remove_partial_download(part_path).await;
            return Err("partial download changed before resume".to_string());
        }
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = match options.open(part_path).await {
        Ok(file) => file,
        Err(error) => {
            remove_partial_download(part_path).await;
            return Err(error.to_string());
        }
    };
    let mut written = resumed_from;
    let mut stream = response.bytes_stream();
    loop {
        let next = if let Some(cancel) = cancellation.as_deref_mut() {
            tokio::select! {
                chunk = stream.next() => chunk,
                _ = cancel.cancelled() => {
                    drop(file);
                    remove_partial_download(part_path).await;
                    return Err("CANCELLED".to_string());
                }
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                drop(file);
                if !resume_supported {
                    remove_partial_download(part_path).await;
                }
                return Err(reqwest_error_without_url(error));
            }
        };
        let chunk_len = chunk.len() as u64;
        let next_written = written.saturating_add(chunk_len);
        if next_written > max_bytes {
            drop(file);
            remove_partial_download(part_path).await;
            return Err("download exceeded the expected size limit".to_string());
        }
        let capacity = {
            let ensure_capacity = space_reservation.ensure_capacity(
                part_path,
                chunk_len,
                planned_size.saturating_sub(written),
            );
            tokio::pin!(ensure_capacity);
            if let Some(cancel) = cancellation.as_deref_mut() {
                tokio::select! {
                    result = &mut ensure_capacity => result,
                    _ = cancel.cancelled() => {
                        drop(file);
                        remove_partial_download(part_path).await;
                        return Err("CANCELLED".to_string());
                    }
                }
            } else {
                ensure_capacity.as_mut().await
            }
        };
        if let Err(error) = capacity {
            drop(file);
            if !resume_supported {
                remove_partial_download(part_path).await;
            }
            return Err(error);
        }
        if let Err(error) = file.write_all(&chunk).await {
            drop(file);
            remove_partial_download(part_path).await;
            return Err(error.to_string());
        }
        written = next_written;
        space_reservation.consume(chunk_len);
    }
    if let Err(error) = file.flush().await {
        drop(file);
        remove_partial_download(part_path).await;
        return Err(error.to_string());
    }
    drop(file);
    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        remove_partial_download(part_path).await;
        return Err("CANCELLED".to_string());
    }
    if written == 0 {
        remove_partial_download(part_path).await;
        return Err("download returned an empty body".to_string());
    }
    if expected_total.is_some_and(|total| written != total) {
        if !resume_supported {
            remove_partial_download(part_path).await;
        }
        return Err("download ended before the expected size was received".to_string());
    }
    if let Err(error) = tokio::fs::rename(part_path, destination).await {
        return Err(error.to_string());
    }
    let _ = tokio::fs::remove_file(resume_metadata_path(part_path)).await;
    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        let _ = tokio::fs::remove_file(destination).await;
        return Err("CANCELLED".to_string());
    }
    Ok(())
}
