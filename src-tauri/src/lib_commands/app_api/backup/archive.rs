use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const LIBRARY_ARCHIVE_ENTRY: &str = "library.sqlite";
const ANALYSIS_ARCHIVE_ENTRY: &str = "audio-analysis.sqlite";
const FULL_ARCHIVE_SETTINGS_ENTRY: &str = "settings.json";
pub(super) const FULL_ARCHIVE_VERSION: u64 = 1;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub(super) struct FullBackupPayload {
    pub(super) version: u64,
    pub(super) app_version: String,
    pub(super) stores: Value,
}

pub(super) fn write_databases_archive(
    library_snapshot: &Path,
    analysis_snapshot: &Path,
    destination_archive: &Path,
) -> Result<(), String> {
    let file = fs::File::create(destination_archive).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(LIBRARY_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut src = fs::File::open(library_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;
    zip.start_file(ANALYSIS_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut analysis_src = fs::File::open(analysis_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut analysis_src, &mut zip).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn write_full_archive(
    library_snapshot: &Path,
    analysis_snapshot: &Path,
    destination_archive: &Path,
    payload: &FullBackupPayload,
) -> Result<(), String> {
    let file = fs::File::create(destination_archive).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file(FULL_ARCHIVE_SETTINGS_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let settings = serde_json::to_vec_pretty(payload).map_err(|e| e.to_string())?;
    zip.write_all(&settings).map_err(|e| e.to_string())?;

    zip.start_file(LIBRARY_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut src = fs::File::open(library_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;

    zip.start_file(ANALYSIS_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut analysis_src = fs::File::open(analysis_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut analysis_src, &mut zip).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn extract_databases_archive(
    source_archive: &Path,
    library_destination_sqlite: &Path,
    analysis_destination_sqlite: &Path,
) -> Result<(), String> {
    let file = fs::File::open(source_archive).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let library_target_index = archive
        .file_names()
        .enumerate()
        .find_map(|(i, name)| (name == LIBRARY_ARCHIVE_ENTRY).then_some(i))
        .ok_or_else(|| "archive does not contain library.sqlite".to_string())?;
    let analysis_target_index = archive
        .file_names()
        .enumerate()
        .find_map(|(i, name)| (name == ANALYSIS_ARCHIVE_ENTRY).then_some(i))
        .ok_or_else(|| "archive does not contain audio-analysis.sqlite".to_string())?;

    if let Some(parent) = library_destination_sqlite.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    {
        let mut library_entry = archive
            .by_index(library_target_index)
            .map_err(|e| e.to_string())?;
        let mut out = fs::File::create(library_destination_sqlite).map_err(|e| e.to_string())?;
        io::copy(&mut library_entry, &mut out).map_err(|e| e.to_string())?;
    }

    if let Some(parent) = analysis_destination_sqlite.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    {
        let mut analysis_entry = archive
            .by_index(analysis_target_index)
            .map_err(|e| e.to_string())?;
        let mut analysis_out =
            fs::File::create(analysis_destination_sqlite).map_err(|e| e.to_string())?;
        io::copy(&mut analysis_entry, &mut analysis_out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn extract_full_archive(
    source_archive: &Path,
    library_destination_sqlite: &Path,
    analysis_destination_sqlite: &Path,
) -> Result<FullBackupPayload, String> {
    let file = fs::File::open(source_archive).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let payload = {
        let mut entry = archive
            .by_name(FULL_ARCHIVE_SETTINGS_ENTRY)
            .map_err(|_| "archive does not contain settings.json".to_string())?;
        let mut buf = Vec::new();
        io::copy(&mut entry, &mut buf).map_err(|e| e.to_string())?;
        serde_json::from_slice::<FullBackupPayload>(&buf).map_err(|e| e.to_string())?
    };
    if payload.version != FULL_ARCHIVE_VERSION {
        return Err("unsupported full backup version".to_string());
    }

    extract_databases_archive(
        source_archive,
        library_destination_sqlite,
        analysis_destination_sqlite,
    )?;
    Ok(payload)
}
