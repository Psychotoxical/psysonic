use rusqlite::{params, OptionalExtension, Transaction};

use super::{
    canonical_optional_artwork, canonical_optional_id, migration_error, record_mapping,
    retarget_entity_rating, stable_json_identity_matches, BatchMutationStats,
};
use crate::navidrome_id_codec::{canonical_id, is_lossless_legacy_id};
use crate::navidrome_payload_codec::{
    canonical_payload, merge_canonical_payloads, NavidromePayloadKind,
};

#[derive(Debug, Clone)]
struct AlbumOwner {
    rowid: i64,
    id: String,
    name: String,
    artist: Option<String>,
    artist_id: Option<String>,
    song_count: Option<i64>,
    duration_sec: Option<i64>,
    year: Option<i64>,
    genre: Option<String>,
    cover_art_id: Option<String>,
    starred_at: Option<i64>,
    synced_at: i64,
    raw_json: Option<String>,
}

pub(super) fn preflight(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<u64> {
    let upper_rowid: i64 = tx.query_row(
        "SELECT COALESCE(MAX(rowid), 0) FROM album WHERE server_id = ?1",
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
            canonical_payload(source.raw_json.as_deref(), NavidromePayloadKind::Album)
                .map_err(migration_error)?;
            let destination_id = canonical_id(&source.id);
            if source.id != destination_id {
                if let Some(destination) = load_owner(tx, server_id, &destination_id)? {
                    ensure_equivalent(&destination, source)?;
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
    for row in &rows {
        record_mapping(tx, "album", row.rowid, &row.id, &canonical_id(&row.id))?;
        canonical_payload(row.raw_json.as_deref(), NavidromePayloadKind::Album)
            .map_err(migration_error)?;
    }

    let mut stats = BatchMutationStats::default();
    for selected in rows {
        stats.processed += 1;
        stats.last_rowid = selected.rowid;
        let Some(source) = load_owner(tx, server_id, &selected.id)? else {
            continue;
        };
        let old_id = source.id.clone();
        let destination_id = canonical_id(&source.id);
        if source.id == destination_id {
            let source = canonicalize_owner(source, destination_id)?;
            write_owner(tx, server_id, &source)?;
            continue;
        }

        let destination = load_owner(tx, server_id, &destination_id)?;
        if let Some(destination) = destination.as_ref() {
            ensure_equivalent(destination, &source)?;
        }
        let merged = match destination {
            Some(destination) => {
                stats.merged += 1;
                merge_owner(destination, source, destination_id.clone())?
            }
            None => {
                stats.moved += 1;
                canonicalize_owner(source, destination_id.clone())?
            }
        };
        write_owner(tx, server_id, &merged)?;
        tx.execute(
            "UPDATE track SET album_id = ?1 WHERE server_id = ?2 AND album_id = ?3",
            params![destination_id, server_id, old_id],
        )?;
        retarget_entity_rating(tx, server_id, "album", &old_id, &destination_id)?;
        tx.execute(
            "DELETE FROM album WHERE server_id = ?1 AND id = ?2",
            params![server_id, old_id],
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
) -> rusqlite::Result<Vec<AlbumOwner>> {
    let mut statement = tx.prepare(
        "SELECT rowid, id, name, artist, artist_id, song_count, duration_sec, year, genre, \
                cover_art_id, starred_at, synced_at, raw_json \
         FROM album WHERE server_id = ?1 AND rowid > ?2 AND rowid <= ?3 \
         ORDER BY rowid LIMIT ?4",
    )?;
    let rows = statement
        .query_map(
            params![server_id, cursor_rowid, upper_rowid, i64::from(limit)],
            row_to_owner,
        )?
        .collect();
    rows
}

fn load_owner(
    tx: &Transaction<'_>,
    server_id: &str,
    id: &str,
) -> rusqlite::Result<Option<AlbumOwner>> {
    tx.query_row(
        "SELECT rowid, id, name, artist, artist_id, song_count, duration_sec, year, genre, \
                cover_art_id, starred_at, synced_at, raw_json \
         FROM album WHERE server_id = ?1 AND id = ?2",
        params![server_id, id],
        row_to_owner,
    )
    .optional()
}

fn row_to_owner(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumOwner> {
    Ok(AlbumOwner {
        rowid: row.get(0)?,
        id: row.get(1)?,
        name: row.get(2)?,
        artist: row.get(3)?,
        artist_id: row.get(4)?,
        song_count: row.get(5)?,
        duration_sec: row.get(6)?,
        year: row.get(7)?,
        genre: row.get(8)?,
        cover_art_id: row.get(9)?,
        starred_at: row.get(10)?,
        synced_at: row.get(11)?,
        raw_json: row.get(12)?,
    })
}

fn ensure_equivalent(destination: &AlbumOwner, source: &AlbumOwner) -> rusqlite::Result<()> {
    if is_lossless_legacy_id(&source.id) {
        return Ok(());
    }
    if stable_json_identity_matches(
        destination.raw_json.as_deref(),
        source.raw_json.as_deref(),
        &["musicBrainzId", "mbzAlbumId", "releaseMbid"],
    )
    .map_err(migration_error)?
    {
        return Ok(());
    }
    let compatible_metadata = !destination.name.trim().is_empty()
        && destination.name.trim().eq_ignore_ascii_case(source.name.trim())
        && canonical_optional_id(destination.artist_id.clone())
            == canonical_optional_id(source.artist_id.clone())
        && destination.artist_id.is_some()
        && destination.year.is_some()
        && destination.year == source.year;
    if compatible_metadata {
        Ok(())
    } else {
        Err(migration_error(format!(
            "unproven Navidrome album collision `{}` -> `{}`",
            source.id, destination.id
        )))
    }
}

fn canonicalize_owner(
    mut source: AlbumOwner,
    destination_id: String,
) -> rusqlite::Result<AlbumOwner> {
    source.id = destination_id;
    source.artist_id = canonical_optional_id(source.artist_id);
    source.cover_art_id = canonical_optional_artwork(source.cover_art_id);
    source.raw_json = canonical_payload(
        source.raw_json.as_deref(),
        NavidromePayloadKind::Album,
    )
    .map_err(migration_error)?;
    Ok(source)
}

fn merge_owner(
    destination: AlbumOwner,
    source: AlbumOwner,
    destination_id: String,
) -> rusqlite::Result<AlbumOwner> {
    let source_is_newer = source.synced_at > destination.synced_at;
    Ok(AlbumOwner {
        rowid: destination.rowid,
        id: destination_id,
        name: prefer_text(destination.name, source.name),
        artist: destination.artist.or(source.artist),
        artist_id: canonical_optional_id(destination.artist_id.or(source.artist_id)),
        song_count: max_optional(destination.song_count, source.song_count),
        duration_sec: max_optional(destination.duration_sec, source.duration_sec),
        year: destination.year.or(source.year),
        genre: destination.genre.or(source.genre),
        cover_art_id: canonical_optional_artwork(
            destination.cover_art_id.or(source.cover_art_id),
        ),
        starred_at: if source_is_newer {
            source.starred_at
        } else {
            destination.starred_at
        },
        synced_at: destination.synced_at.max(source.synced_at),
        raw_json: merge_canonical_payloads(
            destination.raw_json.as_deref(),
            source.raw_json.as_deref(),
            NavidromePayloadKind::Album,
        )
        .map_err(migration_error)?,
    })
}

fn write_owner(
    tx: &Transaction<'_>,
    server_id: &str,
    owner: &AlbumOwner,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO album \
           (server_id, id, name, artist, artist_id, song_count, duration_sec, year, genre, \
            cover_art_id, starred_at, synced_at, raw_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
         ON CONFLICT(server_id, id) DO UPDATE SET \
           name = excluded.name, artist = excluded.artist, artist_id = excluded.artist_id, \
           song_count = excluded.song_count, duration_sec = excluded.duration_sec, \
           year = excluded.year, genre = excluded.genre, cover_art_id = excluded.cover_art_id, \
           starred_at = excluded.starred_at, synced_at = excluded.synced_at, \
           raw_json = excluded.raw_json",
        params![
            server_id,
            owner.id,
            owner.name,
            owner.artist,
            owner.artist_id,
            owner.song_count,
            owner.duration_sec,
            owner.year,
            owner.genre,
            owner.cover_art_id,
            owner.starred_at,
            owner.synced_at,
            owner.raw_json
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
        "SELECT EXISTS(SELECT 1 FROM album WHERE server_id = ?1 AND id = ?2)",
        params![server_id, new_id],
        |row| row.get(0),
    )?;
    let residue: i64 = tx.query_row(
        "SELECT \
           (SELECT COUNT(*) FROM album WHERE server_id = ?1 AND id = ?2) + \
           (SELECT COUNT(*) FROM track WHERE server_id = ?1 AND album_id = ?2) + \
           (SELECT COUNT(*) FROM entity_user_rating \
              WHERE server_id = ?1 AND entity_kind = 'album' AND entity_id = ?2)",
        params![server_id, old_id],
        |row| row.get(0),
    )?;
    if destination_exists && residue == 0 {
        Ok(())
    } else {
        Err(migration_error(format!(
            "album retarget verification failed `{old_id}` -> `{new_id}`"
        )))
    }
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
