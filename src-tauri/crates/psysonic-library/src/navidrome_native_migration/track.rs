use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Transaction};

use super::{
    canonical_optional_artwork, canonical_optional_id, migration_error, record_mapping,
    BatchMutationStats,
};
use crate::navidrome_id_codec::{canonical_id, is_lossless_legacy_id};
use crate::navidrome_payload_codec::{
    canonical_payload, merge_canonical_payloads, NavidromePayloadKind,
};
use crate::repos::track::retarget::retarget_track_references;
use crate::repos::track::{row_to_track_row_at, track_columns, TrackRow, UPSERT_SQL};

#[derive(Debug, Clone)]
struct TrackOwner {
    rowid: i64,
    row: TrackRow,
}

pub(super) fn preflight(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<u64> {
    let upper_rowid: i64 = tx.query_row(
        "SELECT COALESCE(MAX(rowid), 0) FROM track WHERE server_id = ?1",
        params![server_id],
        |row| row.get(0),
    )?;
    let mut cursor_rowid = 0;
    let mut scanned = 0u64;
    loop {
        let rows = load_batch(tx, server_id, cursor_rowid, upper_rowid, super::MAX_BATCH_LIMIT)?;
        let Some(last_rowid) = rows.last().map(|row| row.rowid) else {
            break;
        };
        for source in &rows {
            canonical_payload(
                Some(source.row.raw_json.as_str()),
                NavidromePayloadKind::Track,
            )
            .map_err(migration_error)?;
            let destination_id = canonical_id(&source.row.id);
            if source.row.id != destination_id {
                if let Some(destination) = load_owner(tx, server_id, &destination_id)? {
                    ensure_equivalent(&destination.row, &source.row)?;
                }
            }
        }
        scanned = scanned.saturating_add(rows.len() as u64);
        cursor_rowid = last_rowid;
        if cursor_rowid >= upper_rowid {
            break;
        }
    }
    Ok(scanned)
}

pub(super) fn run_batch(
    tx: &Transaction<'_>,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<BatchMutationStats> {
    let rows = load_batch(tx, server_id, cursor_rowid, upper_rowid, limit)?;
    for owner in &rows {
        record_mapping(
            tx,
            "track",
            owner.rowid,
            &owner.row.id,
            &canonical_id(&owner.row.id),
        )?;
        canonical_payload(
            Some(owner.row.raw_json.as_str()),
            NavidromePayloadKind::Track,
        )
        .map_err(migration_error)?;
    }

    let mut stats = BatchMutationStats::default();
    for selected in rows {
        stats.processed += 1;
        stats.last_rowid = selected.rowid;
        let Some(source) = load_owner(tx, server_id, &selected.row.id)? else {
            continue;
        };
        let old_id = source.row.id.clone();
        let destination_id = canonical_id(&source.row.id);
        if old_id == destination_id {
            let row = canonicalize_owner(source.row, destination_id)?;
            write_owner(tx, &row)?;
            continue;
        }

        let destination = load_owner(tx, server_id, &destination_id)?;
        if let Some(destination) = destination.as_ref() {
            ensure_equivalent(&destination.row, &source.row)?;
        }
        let row = match destination {
            Some(destination) => {
                stats.merged += 1;
                merge_owner(destination.row, source.row, destination_id.clone())?
            }
            None => {
                stats.moved += 1;
                canonicalize_owner(source.row, destination_id.clone())?
            }
        };
        write_owner(tx, &row)?;
        retarget_track_references(
            tx,
            server_id,
            &old_id,
            &destination_id,
            row.content_hash.as_deref(),
            row.server_path.as_deref(),
            now_unix_ms(),
        )?;
        verify_retarget(tx, server_id, &old_id, &destination_id)?;
    }
    Ok(stats)
}

fn load_batch(
    tx: &Transaction<'_>,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<Vec<TrackOwner>> {
    let sql = format!(
        "SELECT rowid, {} FROM track \
         WHERE server_id = ?1 AND rowid > ?2 AND rowid <= ?3 \
         ORDER BY rowid LIMIT ?4",
        track_columns()
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement
        .query_map(
            params![server_id, cursor_rowid, upper_rowid, i64::from(limit)],
            |row| {
                Ok(TrackOwner {
                    rowid: row.get(0)?,
                    row: row_to_track_row_at(row, 1)?,
                })
            },
        )?
        .collect();
    rows
}

fn load_owner(
    tx: &Transaction<'_>,
    server_id: &str,
    id: &str,
) -> rusqlite::Result<Option<TrackOwner>> {
    let sql = format!(
        "SELECT rowid, {} FROM track WHERE server_id = ?1 AND id = ?2",
        track_columns()
    );
    tx.query_row(&sql, params![server_id, id], |row| {
        Ok(TrackOwner {
            rowid: row.get(0)?,
            row: row_to_track_row_at(row, 1)?,
        })
    })
    .optional()
}

fn ensure_equivalent(destination: &TrackRow, source: &TrackRow) -> rusqlite::Result<()> {
    if is_lossless_legacy_id(&source.id) {
        return Ok(());
    }
    let mut matched = false;
    for (label, destination_value, source_value) in [
        (
            "content_hash",
            destination.content_hash.as_deref(),
            source.content_hash.as_deref(),
        ),
        (
            "server_path",
            destination.server_path.as_deref(),
            source.server_path.as_deref(),
        ),
        ("isrc", destination.isrc.as_deref(), source.isrc.as_deref()),
        (
            "mbid_recording",
            destination.mbid_recording.as_deref(),
            source.mbid_recording.as_deref(),
        ),
    ] {
        if let (Some(destination_value), Some(source_value)) = (
            destination_value.filter(|value| !value.is_empty()),
            source_value.filter(|value| !value.is_empty()),
        ) {
            if destination_value != source_value {
                return Err(migration_error(format!(
                    "contradictory Navidrome track collision field `{label}` for `{}` -> `{}`",
                    source.id, destination.id
                )));
            }
            matched = true;
        }
    }
    if matched {
        Ok(())
    } else {
        Err(migration_error(format!(
            "unproven Navidrome track collision `{}` -> `{}`",
            source.id, destination.id
        )))
    }
}

fn canonicalize_owner(
    mut row: TrackRow,
    destination_id: String,
) -> rusqlite::Result<TrackRow> {
    row.id = destination_id;
    row.artist_id = canonical_optional_id(row.artist_id);
    row.album_id = canonical_optional_id(row.album_id);
    row.library_id = canonical_optional_id(row.library_id);
    row.cover_art_id = canonical_optional_artwork(row.cover_art_id);
    row.raw_json = canonical_payload(Some(&row.raw_json), NavidromePayloadKind::Track)
        .map_err(migration_error)?
        .unwrap_or_default();
    Ok(row)
}

fn merge_owner(
    destination: TrackRow,
    source: TrackRow,
    destination_id: String,
) -> rusqlite::Result<TrackRow> {
    let source_is_newer = authority_timestamp(&source) > authority_timestamp(&destination);
    Ok(TrackRow {
        server_id: destination.server_id.clone(),
        id: destination_id,
        title: prefer_text(destination.title, source.title),
        title_sort: destination.title_sort.or(source.title_sort),
        artist: destination.artist.or(source.artist),
        artist_id: canonical_optional_id(destination.artist_id.or(source.artist_id)),
        album: prefer_text(destination.album, source.album),
        album_id: canonical_optional_id(destination.album_id.or(source.album_id)),
        album_artist: destination.album_artist.or(source.album_artist),
        duration_sec: if destination.duration_sec == 0 {
            source.duration_sec
        } else {
            destination.duration_sec
        },
        track_number: destination.track_number.or(source.track_number),
        disc_number: destination.disc_number.or(source.disc_number),
        year: destination.year.or(source.year),
        genre: destination.genre.or(source.genre),
        suffix: destination.suffix.or(source.suffix),
        bit_rate: destination.bit_rate.or(source.bit_rate),
        size_bytes: destination.size_bytes.or(source.size_bytes),
        cover_art_id: canonical_optional_artwork(
            destination.cover_art_id.or(source.cover_art_id),
        ),
        starred_at: if source_is_newer {
            source.starred_at
        } else {
            destination.starred_at
        },
        user_rating: if source_is_newer {
            source.user_rating
        } else {
            destination.user_rating
        },
        play_count: max_optional(destination.play_count, source.play_count),
        played_at: max_optional(destination.played_at, source.played_at),
        server_path: destination.server_path.or(source.server_path),
        library_id: canonical_optional_id(destination.library_id.or(source.library_id)),
        isrc: destination.isrc.or(source.isrc),
        mbid_recording: destination.mbid_recording.or(source.mbid_recording),
        bpm: destination.bpm.or(source.bpm),
        replay_gain_track_db: destination
            .replay_gain_track_db
            .or(source.replay_gain_track_db),
        replay_gain_album_db: destination
            .replay_gain_album_db
            .or(source.replay_gain_album_db),
        replay_gain_peak: destination.replay_gain_peak.or(source.replay_gain_peak),
        content_hash: destination.content_hash.or(source.content_hash),
        server_updated_at: max_optional(
            destination.server_updated_at,
            source.server_updated_at,
        ),
        server_created_at: max_optional(
            destination.server_created_at,
            source.server_created_at,
        ),
        deleted: destination.deleted && source.deleted,
        synced_at: destination.synced_at.max(source.synced_at),
        raw_json: merge_canonical_payloads(
            Some(&destination.raw_json),
            Some(&source.raw_json),
            NavidromePayloadKind::Track,
        )
        .map_err(migration_error)?
        .unwrap_or_default(),
    })
}

fn write_owner(tx: &Transaction<'_>, row: &TrackRow) -> rusqlite::Result<()> {
    tx.execute(
        UPSERT_SQL,
        params![
            row.server_id,
            row.id,
            row.title,
            row.title_sort,
            row.artist,
            row.artist_id,
            row.album,
            row.album_id,
            row.album_artist,
            row.duration_sec,
            row.track_number,
            row.disc_number,
            row.year,
            row.genre,
            row.suffix,
            row.bit_rate,
            row.size_bytes,
            row.cover_art_id,
            row.starred_at,
            row.user_rating,
            row.play_count,
            row.played_at,
            row.server_path,
            row.library_id,
            row.isrc,
            row.mbid_recording,
            row.bpm,
            row.replay_gain_track_db,
            row.replay_gain_album_db,
            row.replay_gain_peak,
            row.content_hash,
            row.server_updated_at,
            row.server_created_at,
            if row.deleted { 1_i64 } else { 0_i64 },
            row.synced_at,
            row.raw_json,
            0_i64,
        ],
    )?;
    Ok(())
}

fn verify_retarget(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    let destination_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM track WHERE server_id = ?1 AND id = ?2)",
        params![server_id, new_id],
        |row| row.get(0),
    )?;
    let residue: i64 = tx.query_row(
        "SELECT \
           (SELECT COUNT(*) FROM track WHERE server_id = ?1 AND id = ?2) + \
           (SELECT COUNT(*) FROM track_offline WHERE server_id = ?1 AND track_id = ?2) + \
           (SELECT COUNT(*) FROM track_extension WHERE server_id = ?1 AND track_id = ?2) + \
           (SELECT COUNT(*) FROM track_fact WHERE server_id = ?1 AND track_id = ?2) + \
           (SELECT COUNT(*) FROM track_artifact WHERE server_id = ?1 AND track_id = ?2) + \
           (SELECT COUNT(*) FROM track_canonical_link WHERE server_id = ?1 AND track_id = ?2) + \
           (SELECT COUNT(*) FROM canonical_enrichment_link \
              WHERE owner_server_id = ?1 AND owner_track_id = ?2) + \
           (SELECT COUNT(*) FROM play_session WHERE server_id = ?1 AND track_id = ?2) + \
           (SELECT COUNT(*) FROM entity_user_rating \
              WHERE server_id = ?1 AND entity_kind = 'track' AND entity_id = ?2) + \
           (SELECT COUNT(*) FROM track_id_history WHERE server_id = ?1 AND new_id = ?2)",
        params![server_id, old_id],
        |row| row.get(0),
    )?;
    if destination_exists && residue == 0 {
        Ok(())
    } else {
        Err(migration_error(format!(
            "track retarget verification failed `{old_id}` -> `{new_id}`"
        )))
    }
}

fn authority_timestamp(row: &TrackRow) -> i64 {
    row.server_updated_at.unwrap_or(row.synced_at)
}

fn prefer_text(destination: String, source: String) -> String {
    if destination.trim().is_empty() {
        source
    } else {
        destination
    }
}

fn max_optional(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
