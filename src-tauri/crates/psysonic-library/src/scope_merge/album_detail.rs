use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value;

use super::artist_candidates::album_artist_id_expr;
use super::common::{
    ensure_cluster_keys_for_all_scopes, keyed_detail_track_source, non_empty_scopes,
    plain_track_columns_sql, scope_cte_sql, TRACK_DEDUP_KEY,
};
use super::entity_sources::lookup_album_key;
use crate::album_compilation_filter::{
    pick_album_group_artist_id, resolve_album_credit, various_artists_label,
};
use crate::browse_support::read_album_starred_at;
use crate::dto::{
    LibraryAlbumDto, LibraryScopeAlbumDetailRequest, LibraryScopeAlbumDetailResponse,
    LibraryScopePair, LibraryTrackDto,
};
use crate::repos::row_to_track_row;
use crate::search::aliased_track_columns;
use crate::store::LibraryStore;

/// Caller must pre-sort `candidates` by full scope-pair priority (lowest index first).
fn priority_album_candidate(candidates: &[LibraryAlbumDto]) -> LibraryAlbumDto {
    candidates
        .first()
        .cloned()
        .unwrap_or_else(|| LibraryAlbumDto {
            server_id: String::new(),
            id: String::new(),
            name: String::new(),
            artist: None,
            artist_id: None,
            song_count: None,
            duration_sec: None,
            year: None,
            genre: None,
            cover_art_id: None,
            starred_at: None,
            synced_at: 0,
            raw_json: Value::Null,
        })
}

fn overlay_priority_album_row(
    conn: &rusqlite::Connection,
    album: &mut LibraryAlbumDto,
) -> rusqlite::Result<()> {
    let row = conn
        .query_row(
            "SELECT name, artist, artist_id, song_count, duration_sec, year, genre, cover_art_id, \
                    starred_at, synced_at, raw_json \
             FROM album WHERE server_id = ?1 AND id = ?2",
            rusqlite::params![&album.server_id, &album.id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()?;
    let Some((
        name,
        artist,
        artist_id,
        song_count,
        duration_sec,
        year,
        genre,
        cover_art_id,
        starred_at,
        synced_at,
        raw_json,
    )) = row
    else {
        return Ok(());
    };
    album.name = name;
    // Album-artist identity from the standalone row. `upsert_album_from_get_album`
    // persists getAlbum's album-artist *name* correctly (e.g. "Various Artists") but
    // the sync `Album` type maps only the legacy `artistId`, which on a compilation
    // is a representative performer. So take the name from `albumArtist`/the legacy
    // `artist` column (never the track-derived candidate — that would resurface a
    // "feat." credit), and run the id through the same VA-aware rule used everywhere
    // else: prefer `albumArtistId`, and leave a Various Artists credit unlinked
    // rather than pointing it at a guest performer.
    let parsed_raw: Option<Value> = raw_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    let raw_field = |key: &str| -> Option<String> {
        parsed_raw
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let derived_name = album.artist.take().filter(|s| !s.trim().is_empty());
    let derived_id = album.artist_id.take().filter(|s| !s.trim().is_empty());
    // Name: server `albumArtist`, then the standalone row's clean album-artist column
    // (getAlbum's album artist), then — only if both are empty — the track-derived
    // candidate. The clean column must beat the candidate, or a per-track "feat."
    // credit resurfaces in the header.
    let final_name = raw_field("albumArtist").or(artist).or(derived_name.clone());
    // Id resolution runs `pick_album_group_artist_id` against the FINAL name, so a
    // Various Artists header without a real album-artist id stays unlinked instead of
    // opening a guest. The only value trusted as an album-artist id is one that came
    // from an album-artist source: the server's `albumArtistId`, or the candidate's
    // id *when the candidate itself resolved a VA/album-artist name* — a candidate id
    // paired with a performer name is a performer, not an album artist, and must not
    // survive under a VA header sourced from the album row. `artist_id` (legacy row
    // column) / the candidate id serve only as the non-VA performer fallback.
    let candidate_album_artist_id = derived_id
        .clone()
        .filter(|_| derived_name.as_deref().is_some_and(various_artists_label));
    album.artist_id = pick_album_group_artist_id(
        artist_id.or(derived_id),
        final_name.as_deref(),
        raw_field("albumArtistId").or(candidate_album_artist_id),
    );
    album.artist = final_name;
    album.song_count = song_count;
    album.duration_sec = duration_sec;
    album.year = year;
    album.genre = genre;
    album.cover_art_id = cover_art_id;
    album.starred_at = starred_at;
    album.synced_at = synced_at;
    album.raw_json = parsed_raw.unwrap_or(Value::Null);
    Ok(())
}

fn fetch_album_candidates(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    album_key: Option<&str>,
    anchor_server: &str,
    anchor_album_id: &str,
) -> rusqlite::Result<Vec<(i64, LibraryAlbumDto)>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        album_key.map(|_| "album_key"),
        "AND t.server_id = ? AND t.album_id = ?",
    );
    let sql = format!(
        "{cte}, \
         grouped AS ( \
           SELECT t.server_id, t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist, \
                   MAX(t.artist_id) AS artist_id, MAX(t.album_artist) AS album_artist, \
                   MAX(t.year) AS year, MAX(t.genre) AS genre, MAX(t.cover_art_id) AS cover_art_id, \
                   MAX(t.starred_at) AS starred_at, MAX(t.synced_at) AS synced_at, \
                   COUNT(*) AS song_count, SUM(t.duration_sec) AS duration_total, MIN({priority}) AS best_pr, \
                   MAX({album_artist_id}) AS album_artist_id \
            {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
           GROUP BY t.server_id, t.album_id \
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, song_count, duration_total, \
                year, genre, cover_art_id, starred_at, synced_at, best_pr, album_artist_id \
         FROM grouped ORDER BY best_pr ASC",
        scoped = scoped,
        album_artist_id = album_artist_id_expr("t.raw_json"),
    );
    let mut binds = scope_binds;
    if let Some(key) = album_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_album_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            let pr: i64 = r.get(13)?;
            // Same shared VA-aware rule as every other album-DTO mapper: the hero
            // credit prefers the album-artist name and the linked id follows the same
            // choice (`album_artist_id` = the server's `raw_json.albumArtistId`).
            let (artist, artist_id) =
                resolve_album_credit(r.get(3)?, r.get(4)?, r.get(5)?, r.get(14)?);
            Ok((
                pr,
                LibraryAlbumDto {
                    server_id: r.get(0)?,
                    id: r.get(1)?,
                    name: r.get(2)?,
                    artist,
                    artist_id,
                    song_count: Some(r.get(6)?),
                    duration_sec: Some(r.get(7)?),
                    year: r.get(8)?,
                    genre: r.get(9)?,
                    cover_art_id: r.get(10)?,
                    starred_at: r.get(11)?,
                    synced_at: r.get(12)?,
                    raw_json: Value::Null,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn fetch_scope_deduped_tracks_for_album_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    album_key: Option<&str>,
    anchor_server: &str,
    anchor_album_id: &str,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        album_key.map(|_| "album_key"),
        "AND t.server_id = ? AND t.album_id = ?",
    );
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, {priority} AS pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY {priority} ASC, t.id ASC) AS rn \
            {scoped} AND t.album_id IS NOT NULL {key_filter} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 \
         ORDER BY COALESCE(disc_number, 1) ASC, track_number ASC NULLS LAST, id ASC, server_id ASC",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = album_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_album_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(LibraryTrackDto::from_row(&row_to_track_row(r)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// `library_scope_album_detail` — resolve anchor → `album_key`, aggregate tracks + metadata.
pub fn album_detail(
    store: &LibraryStore,
    request: &LibraryScopeAlbumDetailRequest,
) -> Result<LibraryScopeAlbumDetailResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
    let server_id = request.server_id.trim();
    let album_id = request.album_id.trim();
    if server_id.is_empty() || album_id.is_empty() {
        return Err("server_id and album_id are required".into());
    }

    store.with_read_conn(|conn| {
        let album_key = lookup_album_key(conn, server_id, album_id)?;
        let candidates =
            fetch_album_candidates(conn, scopes, album_key.as_deref(), server_id, album_id)?;
        let albums: Vec<LibraryAlbumDto> = candidates.into_iter().map(|(_, album)| album).collect();
        let mut album = priority_album_candidate(&albums);
        overlay_priority_album_row(conn, &mut album)?;
        album.starred_at = read_album_starred_at(conn, &album.server_id, &album.id).unwrap_or(None);
        let tracks = fetch_scope_deduped_tracks_for_album_key(
            conn,
            scopes,
            album_key.as_deref(),
            server_id,
            album_id,
        )?;
        Ok(LibraryScopeAlbumDetailResponse { album, tracks })
    })
}
