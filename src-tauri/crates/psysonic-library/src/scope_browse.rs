//! Candidate-first, cursor-paginated browse over ordered library scopes.
//!
//! Advanced Search remains responsible for FTS and arbitrary compound filters.
//! This module serves ordinary catalogue pages from materialized/indexed rows.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};

use crate::browse_support::overlay_album_artist_links;
use crate::dto::{
    LibraryAlbumDto, LibraryScopeBrowseEntity, LibraryScopeBrowseRequest,
    LibraryScopeBrowseResponse, LibraryScopePair, LibrarySortClause, LibraryTrackDto,
};
use crate::repos::{row_to_track_row, TrackRow};
use crate::scope_merge::TRACK_CLUSTER_PARTITION_KEY;
use crate::store::LibraryStore;

const CANDIDATE_PAGE_SIZE: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum AlbumSort {
    Name,
    Artist,
    ArtistYear,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AlbumCursor {
    scope_key: String,
    sort: AlbumSort,
    positions: Vec<Option<AlbumCursorPosition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AlbumCursorPosition {
    name: String,
    artist: String,
    year: i64,
    album_id: String,
}

#[derive(Debug, Clone)]
struct AlbumCandidate {
    priority: usize,
    server_id: String,
    library_id: String,
    album_id: String,
    identity_key: Option<String>,
    name: String,
    artist: Option<String>,
    artist_id: Option<String>,
    song_count: i64,
    duration_sec: i64,
    year: Option<i64>,
    genre: Option<String>,
    cover_art_id: Option<String>,
    starred_at: Option<i64>,
    synced_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackCursor {
    scope_key: String,
    positions: Vec<Option<TrackCursorPosition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackCursorPosition {
    title: String,
    track_id: String,
}

#[derive(Debug, Clone)]
struct TrackCandidate {
    priority: usize,
    library_id: String,
    track: TrackRow,
    identity_key: Option<String>,
}

fn album_sort(sort: &[LibrarySortClause]) -> Result<AlbumSort, String> {
    let fields: Vec<&str> = sort.iter().map(|clause| clause.field.as_str()).collect();
    match fields.as_slice() {
        [] | ["name"] | ["name", "artist"] => Ok(AlbumSort::Name),
        ["artist"] | ["artist", "name"] => Ok(AlbumSort::Artist),
        ["artist", "year"] | ["artist", "year", "name"] => Ok(AlbumSort::ArtistYear),
        _ => Err("unsupported scope browse album sort".into()),
    }
}

fn order_sql(sort: AlbumSort) -> &'static str {
    match sort {
        AlbumSort::Name => {
            "name COLLATE NOCASE ASC, COALESCE(artist, '') COLLATE NOCASE ASC, album_id ASC"
        }
        AlbumSort::Artist => {
            "COALESCE(artist, '') COLLATE NOCASE ASC, name COLLATE NOCASE ASC, album_id ASC"
        }
        AlbumSort::ArtistYear => {
            "COALESCE(artist, '') COLLATE NOCASE ASC, COALESCE(year, 0) ASC, name COLLATE NOCASE ASC, album_id ASC"
        }
    }
}

fn candidate_cmp(sort: AlbumSort, a: &AlbumCandidate, b: &AlbumCandidate) -> Ordering {
    let fold = |value: &str| value.to_lowercase();
    let by_name = || fold(&a.name).cmp(&fold(&b.name));
    let by_artist = || fold(a.artist.as_deref().unwrap_or("")).cmp(&fold(b.artist.as_deref().unwrap_or("")));
    let order = match sort {
        AlbumSort::Name => by_name().then_with(by_artist),
        AlbumSort::Artist => by_artist().then_with(by_name),
        AlbumSort::ArtistYear => by_artist()
            .then_with(|| a.year.unwrap_or(0).cmp(&b.year.unwrap_or(0)))
            .then_with(by_name),
    };
    order
        .then_with(|| a.priority.cmp(&b.priority))
        .then_with(|| a.server_id.cmp(&b.server_id))
        .then_with(|| a.library_id.cmp(&b.library_id))
        .then_with(|| a.album_id.cmp(&b.album_id))
}

fn candidate_to_dto(candidate: AlbumCandidate) -> LibraryAlbumDto {
    LibraryAlbumDto {
        server_id: candidate.server_id,
        id: candidate.album_id,
        name: candidate.name,
        artist: candidate.artist,
        artist_id: candidate.artist_id,
        song_count: Some(candidate.song_count),
        duration_sec: Some(candidate.duration_sec),
        year: candidate.year,
        genre: candidate.genre,
        cover_art_id: candidate.cover_art_id,
        starred_at: candidate.starred_at,
        synced_at: candidate.synced_at,
        raw_json: serde_json::Value::Null,
    }
}

fn scope_key(scopes: &[LibraryScopePair]) -> String {
    scopes
        .iter()
        .map(|scope| {
            format!(
                "{}\u{1f}{}",
                scope.server_id,
                scope.library_id.as_deref().unwrap_or("\u{0}")
            )
        })
        .collect::<Vec<_>>()
        .join("\u{1e}")
}

fn parse_cursor(
    cursor: Option<&str>,
    scopes: &[LibraryScopePair],
    sort: AlbumSort,
) -> Result<Option<AlbumCursor>, String> {
    let Some(raw) = cursor else {
        return Ok(None);
    };
    let parsed: AlbumCursor = serde_json::from_str(raw).map_err(|_| "invalid scope browse cursor")?;
    if parsed.scope_key != scope_key(scopes) || parsed.sort != sort || parsed.positions.len() != scopes.len() {
        return Err("scope browse cursor does not match the current scope or sort".into());
    }
    Ok(Some(parsed))
}

fn cursor_position(candidate: &AlbumCandidate) -> AlbumCursorPosition {
    AlbumCursorPosition {
        name: candidate.name.clone(),
        artist: candidate.artist.clone().unwrap_or_default(),
        year: candidate.year.unwrap_or(0),
        album_id: candidate.album_id.clone(),
    }
}

fn seek_sql(sort: AlbumSort, position: Option<&AlbumCursorPosition>) -> (String, Vec<SqlValue>) {
    let Some(position) = position else {
        return (String::new(), Vec::new());
    };
    match sort {
        AlbumSort::Name => (
            "AND (name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND (COALESCE(artist, '') COLLATE NOCASE > ? OR (COALESCE(artist, '') COLLATE NOCASE = ? AND album_id > ?))))".into(),
            vec![
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.album_id.clone()),
            ],
        ),
        AlbumSort::Artist => (
            "AND (COALESCE(artist, '') COLLATE NOCASE > ? OR (COALESCE(artist, '') COLLATE NOCASE = ? AND (name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND album_id > ?))))".into(),
            vec![
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.album_id.clone()),
            ],
        ),
        AlbumSort::ArtistYear => (
            "AND (COALESCE(artist, '') COLLATE NOCASE > ? OR (COALESCE(artist, '') COLLATE NOCASE = ? AND (COALESCE(year, 0) > ? OR (COALESCE(year, 0) = ? AND (name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND album_id > ?))))))".into(),
            vec![
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Integer(position.year),
                SqlValue::Integer(position.year),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.album_id.clone()),
            ],
        ),
    }
}

fn query_scope_candidates(
    store: &LibraryStore,
    pair: &LibraryScopePair,
    priority: usize,
    sort: AlbumSort,
    cursor_position: Option<&AlbumCursorPosition>,
    limit: usize,
) -> Result<Vec<AlbumCandidate>, String> {
    let (seek, mut binds) = seek_sql(sort, cursor_position);
    let library_filter = if pair.library_id.is_some() {
        " AND library_id = ?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT server_id, library_id, album_id, identity_key, name, artist, artist_id, song_count, \
                 duration_sec, year, genre, cover_art_id, starred_at, synced_at \
         FROM album_browse_projection \
         WHERE server_id = ? {library_filter} {seek} \
         ORDER BY {} LIMIT ?",
        order_sql(sort),
    );
    let mut scope_binds = vec![SqlValue::Text(pair.server_id.clone())];
    if let Some(library_id) = &pair.library_id {
        scope_binds.push(SqlValue::Text(library_id.clone()));
    }
    binds.splice(0..0, scope_binds);
    binds.push(SqlValue::Integer(limit as i64));
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                params_from_iter(binds.iter()),
                |row| {
                    Ok(AlbumCandidate {
                        priority,
                        server_id: row.get(0)?,
                        library_id: row.get(1)?,
                        album_id: row.get(2)?,
                        identity_key: row.get(3)?,
                        name: row.get(4)?,
                        artist: row.get(5)?,
                        artist_id: row.get(6)?,
                        song_count: row.get(7)?,
                        duration_sec: row.get(8)?,
                        year: row.get(9)?,
                        genre: row.get(10)?,
                        cover_art_id: row.get(11)?,
                        starred_at: row.get(12)?,
                        synced_at: row.get(13)?,
                    })
                },
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())
}

fn album_identity_priorities(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    candidates: &[Vec<AlbumCandidate>],
) -> Result<HashMap<String, usize>, String> {
    let identities = candidates
        .iter()
        .flatten()
        .filter_map(|candidate| candidate.identity_key.clone())
        .collect::<HashSet<_>>();
    if identities.is_empty() {
        return Ok(HashMap::new());
    }
    let (scope_cte, mut binds) = crate::scope_merge::scope_cte_sql(scopes);
    let placeholders = (0..identities.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "{scope_cte} SELECT projection.identity_key, MIN(scope.pr) \
         FROM scope \
         INNER JOIN album_browse_projection projection \
           ON projection.server_id = scope.server_id \
          AND projection.library_id = scope.library_id \
         WHERE projection.identity_key IN ({placeholders}) \
         GROUP BY projection.identity_key",
    );
    binds.extend(identities.into_iter().map(SqlValue::Text));
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
            })?;
            rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        })
        .map_err(|error| error.to_string())
}

fn browse_albums(
    store: &LibraryStore,
    request: &LibraryScopeBrowseRequest,
) -> Result<LibraryScopeBrowseResponse, String> {
    let sort = album_sort(&request.sort)?;
    let cursor = parse_cursor(request.cursor.as_deref(), &request.scopes, sort)?;
    if cursor.is_none() {
        crate::scope_merge::ensure_cluster_keys_for_scopes(store, &request.scopes)?;
    }
    let limit = request.limit.clamp(1, 200) as usize;
    let candidate_limit = CANDIDATE_PAGE_SIZE.max(limit.saturating_add(1));
    let mut candidates = Vec::with_capacity(request.scopes.len());
    let mut stream_exhausted = Vec::with_capacity(request.scopes.len());
    for (priority, scope) in request.scopes.iter().enumerate() {
        let stream = query_scope_candidates(
            store,
            scope,
            priority,
            sort,
            cursor.as_ref().and_then(|cursor| cursor.positions.get(priority)).and_then(Option::as_ref),
            candidate_limit,
        )?;
        stream_exhausted.push(stream.len() < candidate_limit);
        candidates.push(stream);
    }
    let mut identity_priorities = album_identity_priorities(store, &request.scopes, &candidates)?;

    let mut albums = Vec::with_capacity(limit.saturating_add(1));
    let mut offsets = vec![0usize; candidates.len()];
    let mut positions = cursor
        .map(|cursor| cursor.positions)
        .unwrap_or_else(|| vec![None; request.scopes.len()]);
    while albums.len() < limit {
        for scope_index in 0..candidates.len() {
            if offsets[scope_index] < candidates[scope_index].len() || stream_exhausted[scope_index] {
                continue;
            }
            let stream = query_scope_candidates(
                store,
                &request.scopes[scope_index],
                scope_index,
                sort,
                positions[scope_index].as_ref(),
                candidate_limit,
            )?;
            stream_exhausted[scope_index] = stream.len() < candidate_limit;
            candidates[scope_index] = stream;
            offsets[scope_index] = 0;
            identity_priorities = album_identity_priorities(store, &request.scopes, &candidates)?;
        }
        let next_scope = candidates
            .iter()
            .enumerate()
            .filter(|(index, stream)| offsets[*index] < stream.len())
            .min_by(|(left_index, left_stream), (right_index, right_stream)| {
                candidate_cmp(
                    sort,
                    &left_stream[offsets[*left_index]],
                    &right_stream[offsets[*right_index]],
                )
            })
            .map(|(index, _)| index);
        let Some(scope_index) = next_scope else { break; };
        let candidate = &candidates[scope_index][offsets[scope_index]];
        offsets[scope_index] += 1;
        positions[scope_index] = Some(cursor_position(candidate));
        if let Some(identity_key) = candidate.identity_key.as_deref() {
            if identity_priorities
                .get(identity_key)
                .is_some_and(|priority| *priority < candidate.priority)
            {
                continue;
            }
        }
        albums.push(candidate_to_dto(candidate.clone()));
    }
    // The projection stores the display credit and a representative track's performer id
    // side by side, so a compilation row reads "Various Artists" with a guest's id. Which
    // entity that credit links to belongs to the whole physical album, exactly as in the
    // merge paths — this is the page every "All Albums" grid renders.
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .map_err(|error| error.to_string())?;
    let has_more = candidates
        .iter()
        .enumerate()
        .any(|(index, stream)| offsets[index] < stream.len() || !stream_exhausted[index]);
    let next_cursor = has_more.then(|| {
        serde_json::to_string(&AlbumCursor {
            scope_key: scope_key(&request.scopes),
            sort,
            positions,
        })
        .expect("scope browse cursor serializes")
    });
    Ok(LibraryScopeBrowseResponse {
        albums,
        artists: Vec::new(),
        tracks: Vec::new(),
        next_cursor,
        has_more,
        source: "local".into(),
    })
}

fn parse_track_cursor(
    cursor: Option<&str>,
    scopes: &[LibraryScopePair],
) -> Result<Option<TrackCursor>, String> {
    let Some(raw) = cursor else {
        return Ok(None);
    };
    let parsed: TrackCursor = serde_json::from_str(raw).map_err(|_| "invalid scope browse cursor")?;
    if parsed.scope_key != scope_key(scopes) || parsed.positions.len() != scopes.len() {
        return Err("scope browse cursor does not match the current scope".into());
    }
    Ok(Some(parsed))
}

fn track_cursor_position(candidate: &TrackCandidate) -> TrackCursorPosition {
    TrackCursorPosition {
        title: candidate.track.title.clone(),
        track_id: candidate.track.id.clone(),
    }
}

fn query_track_scope_candidates(
    store: &LibraryStore,
    pair: &LibraryScopePair,
    priority: usize,
    cursor_position: Option<&TrackCursorPosition>,
    limit: usize,
) -> Result<Vec<TrackCandidate>, String> {
    let (seek, mut binds) = match cursor_position {
        Some(position) => (
            "AND (t.title COLLATE NOCASE > ? OR (t.title COLLATE NOCASE = ? AND t.id > ?))",
            vec![
                SqlValue::Text(position.title.clone()),
                SqlValue::Text(position.title.clone()),
                SqlValue::Text(position.track_id.clone()),
            ],
        ),
        None => ("", Vec::new()),
    };
    let columns = crate::search::aliased_track_columns("t");
    let library_filter = if pair.library_id.is_some() {
        " AND t.library_id = ?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {columns}, CASE WHEN ck.cluster_key IS NOT NULL \
         THEN {TRACK_CLUSTER_PARTITION_KEY} END \
         FROM track t \
         LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.server_id = ? {library_filter} AND t.deleted = 0 {seek} \
         ORDER BY t.title COLLATE NOCASE ASC, t.id ASC LIMIT ?",
    );
    let mut scope_binds = vec![SqlValue::Text(pair.server_id.clone())];
    if let Some(library_id) = &pair.library_id {
        scope_binds.push(SqlValue::Text(library_id.clone()));
    }
    binds.splice(0..0, scope_binds);
    binds.push(SqlValue::Integer(limit as i64));
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
                let track = row_to_track_row(row)?;
                Ok(TrackCandidate {
                    priority,
                    library_id: track.library_id.clone().unwrap_or_default(),
                    track,
                    identity_key: row.get(crate::search::track_projection_column_count())?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())
}

fn track_candidate_cmp(a: &TrackCandidate, b: &TrackCandidate) -> Ordering {
    a.track.title.to_lowercase().cmp(&b.track.title.to_lowercase())
        .then_with(|| a.priority.cmp(&b.priority))
        .then_with(|| a.track.server_id.cmp(&b.track.server_id))
        .then_with(|| a.library_id.cmp(&b.library_id))
        .then_with(|| a.track.id.cmp(&b.track.id))
}

/// Resolve the highest-priority selected scope for every identity represented
/// in the candidate streams. This keeps cursor pages correct when the winner
/// was consumed on an earlier page, without doing an `EXISTS` query per row.
fn track_identity_priorities(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    candidates: &[Vec<TrackCandidate>],
) -> Result<HashMap<String, usize>, String> {
    let identities = candidates
        .iter()
        .flatten()
        .filter_map(|candidate| candidate.identity_key.clone())
        .collect::<HashSet<_>>();
    if identities.is_empty() {
        return Ok(HashMap::new());
    }
    let (scope_cte, mut binds) = crate::scope_merge::scope_cte_sql(scopes);
    let placeholders = (0..identities.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "{scope_cte} SELECT {TRACK_CLUSTER_PARTITION_KEY}, MIN(scope.pr) \
         FROM scoped_track scope \
         INNER JOIN track t ON t.rowid = scope.rowid \
         INNER JOIN cluster.track_cluster_key ck \
           ON ck.server_id = t.server_id AND ck.track_id = t.id \
          WHERE t.deleted = 0 AND {TRACK_CLUSTER_PARTITION_KEY} IN ({placeholders}) \
          GROUP BY {TRACK_CLUSTER_PARTITION_KEY}",
    );
    binds.extend(identities.into_iter().map(SqlValue::Text));
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
            })?;
            rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        })
        .map_err(|error| error.to_string())
}

fn browse_tracks(
    store: &LibraryStore,
    request: &LibraryScopeBrowseRequest,
) -> Result<LibraryScopeBrowseResponse, String> {
    if !request.sort.is_empty() && request.sort.iter().any(|clause| clause.field != "title") {
        return Err("unsupported scope browse track sort".into());
    }
    let cursor = parse_track_cursor(request.cursor.as_deref(), &request.scopes)?;
    // Initial browse ensures a newly synced scope has identity rows. Cursor
    // pages reuse that prepared snapshot and must stay read-only hot paths.
    if cursor.is_none() {
        crate::scope_merge::ensure_cluster_keys_for_scopes(store, &request.scopes)?;
    }
    let limit = request.limit.clamp(1, 200) as usize;
    let candidate_limit = CANDIDATE_PAGE_SIZE.max(limit.saturating_add(1));
    let mut candidates = Vec::with_capacity(request.scopes.len());
    let mut stream_exhausted = Vec::with_capacity(request.scopes.len());
    for (priority, scope) in request.scopes.iter().enumerate() {
        let stream = query_track_scope_candidates(
            store,
            scope,
            priority,
            cursor.as_ref().and_then(|cursor| cursor.positions.get(priority)).and_then(Option::as_ref),
            candidate_limit,
        )?;
        stream_exhausted.push(stream.len() < candidate_limit);
        candidates.push(stream);
    }
    let mut identity_priorities = track_identity_priorities(store, &request.scopes, &candidates)?;

    let mut tracks = Vec::with_capacity(limit);
    let mut offsets = vec![0usize; candidates.len()];
    let mut positions = cursor
        .map(|cursor| cursor.positions)
        .unwrap_or_else(|| vec![None; request.scopes.len()]);
    while tracks.len() < limit {
        for scope_index in 0..candidates.len() {
            if offsets[scope_index] < candidates[scope_index].len() || stream_exhausted[scope_index] {
                continue;
            }
            let stream = query_track_scope_candidates(
                store,
                &request.scopes[scope_index],
                scope_index,
                positions[scope_index].as_ref(),
                candidate_limit,
            )?;
            stream_exhausted[scope_index] = stream.len() < candidate_limit;
            candidates[scope_index] = stream;
            offsets[scope_index] = 0;
            identity_priorities = track_identity_priorities(store, &request.scopes, &candidates)?;
        }
        let next_scope = candidates
            .iter()
            .enumerate()
            .filter(|(index, stream)| offsets[*index] < stream.len())
            .min_by(|(left_index, left_stream), (right_index, right_stream)| {
                track_candidate_cmp(
                    &left_stream[offsets[*left_index]],
                    &right_stream[offsets[*right_index]],
                )
            })
            .map(|(index, _)| index);
        let Some(scope_index) = next_scope else { break; };
        let candidate = &candidates[scope_index][offsets[scope_index]];
        offsets[scope_index] += 1;
        positions[scope_index] = Some(track_cursor_position(candidate));
        if let Some(identity_key) = candidate.identity_key.as_deref() {
            if identity_priorities
                .get(identity_key)
                .is_some_and(|priority| *priority < candidate.priority)
            {
                continue;
            }
        }
        tracks.push(LibraryTrackDto::from_row(&candidate.track));
    }
    let has_more = candidates
        .iter()
        .enumerate()
        .any(|(index, stream)| offsets[index] < stream.len() || !stream_exhausted[index]);
    let next_cursor = has_more.then(|| {
        serde_json::to_string(&TrackCursor {
            scope_key: scope_key(&request.scopes),
            positions,
        })
        .expect("scope browse cursor serializes")
    });
    Ok(LibraryScopeBrowseResponse {
        albums: Vec::new(),
        artists: Vec::new(),
        tracks,
        next_cursor,
        has_more,
        source: "local".into(),
    })
}

pub fn browse(
    store: &LibraryStore,
    request: &LibraryScopeBrowseRequest,
) -> Result<LibraryScopeBrowseResponse, String> {
    crate::scope_merge::non_empty_scopes(&request.scopes)?;
    match request.entity {
        LibraryScopeBrowseEntity::Album => {
            if !crate::browse_projection::is_ready(store)? {
                return Err("scope browse projection is not ready".into());
            }
            browse_albums(store, request)
        }
        LibraryScopeBrowseEntity::Track => browse_tracks(store, request),
        LibraryScopeBrowseEntity::Artist => Err("scope browse entity is not implemented yet".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(scopes: Vec<LibraryScopePair>, limit: u32, cursor: Option<String>) -> LibraryScopeBrowseRequest {
        LibraryScopeBrowseRequest {
            entity: LibraryScopeBrowseEntity::Album,
            scopes,
            sort: vec![
                LibrarySortClause { field: "name".into(), dir: crate::dto::SortDir::Asc },
                LibrarySortClause { field: "artist".into(), dir: crate::dto::SortDir::Asc },
            ],
            limit,
            cursor,
        }
    }

    fn track_request(scopes: Vec<LibraryScopePair>, limit: u32, cursor: Option<String>) -> LibraryScopeBrowseRequest {
        LibraryScopeBrowseRequest {
            entity: LibraryScopeBrowseEntity::Track,
            scopes,
            sort: vec![LibrarySortClause { field: "title".into(), dir: crate::dto::SortDir::Asc }],
            limit,
            cursor,
        }
    }

    fn insert_track(
        store: &LibraryStore,
        server_id: &str,
        library_id: &str,
        track_id: &str,
        title: &str,
        cluster_key: Option<&str>,
    ) {
        store.with_conn_mut("test.scope_browse.track_seed", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, artist, album, library_id, synced_at, raw_json) \
                 VALUES (?1, ?2, ?3, 'Artist', 'Album', ?4, 1, '{}')",
                rusqlite::params![server_id, track_id, title, library_id],
            )?;
            if let Some(cluster_key) = cluster_key {
                conn.execute(
                    "INSERT INTO cluster.track_cluster_key \
                     (server_id, library_id, track_id, cluster_key, duration_sec) \
                     VALUES (?1, ?2, ?3, ?4, 100)",
                    rusqlite::params![server_id, library_id, track_id, cluster_key],
                )?;
            }
            Ok(())
        }).unwrap();
    }

    fn insert_projection(
        store: &LibraryStore,
        server_id: &str,
        library_id: &str,
        album_id: &str,
        name: &str,
        identity_key: Option<&str>,
    ) {
        store.with_conn_mut("test.scope_browse.seed", |conn| {
            conn.execute(
                "INSERT INTO album_browse_projection ( \
                   server_id, library_id, album_id, identity_key, name, artist, artist_id, song_count, \
                   duration_sec, year, genre, cover_art_id, starred_at, synced_at, representative_track_id \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'Artist', NULL, 1, 1, 2024, NULL, NULL, NULL, 1, ?3)",
                rusqlite::params![server_id, library_id, album_id, identity_key, name],
            )?;
            conn.execute(
                "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
                 VALUES ('scope_browse_album_projection_v1', 0, 1, 1) \
                 ON CONFLICT(id) DO UPDATE SET completed_at = 1",
                [],
            )?;
            Ok(())
        }).unwrap();
    }

    #[test]
    fn whole_server_streams_include_empty_library_and_exact_empty_stays_narrow() {
        let store = LibraryStore::open_in_memory();
        insert_projection(&store, "s1", "", "empty-album", "Alpha", Some("empty"));
        insert_projection(&store, "s1", "lib-b", "tagged-album", "Bravo", Some("tagged"));
        insert_track(&store, "s1", "", "empty-track", "Alpha", Some("empty-track"));
        insert_track(&store, "s1", "lib-b", "tagged-track", "Bravo", Some("tagged-track"));

        let whole = vec![LibraryScopePair { server_id: "s1".into(), library_id: None }];
        let albums = browse(&store, &request(whole.clone(), 10, None)).unwrap();
        assert_eq!(
            albums.albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(),
            vec!["empty-album", "tagged-album"]
        );
        let tracks = browse(&store, &track_request(whole, 10, None)).unwrap();
        assert_eq!(
            tracks.tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(),
            vec!["empty-track", "tagged-track"]
        );

        let exact_empty = vec![LibraryScopePair {
            server_id: "s1".into(),
            library_id: Some(String::new()),
        }];
        let albums = browse(&store, &request(exact_empty.clone(), 10, None)).unwrap();
        assert_eq!(albums.albums.len(), 1);
        assert_eq!(albums.albums[0].id, "empty-album");
        let tracks = browse(&store, &track_request(exact_empty, 10, None)).unwrap();
        assert_eq!(tracks.tracks.len(), 1);
        assert_eq!(tracks.tracks[0].id, "empty-track");
    }

    #[test]
    fn priority_scope_wins_even_when_its_duplicate_sorts_later() {
        let store = LibraryStore::open_in_memory();
        insert_projection(&store, "high", "lib", "high-dup", "Zulu", Some("same"));
        insert_projection(&store, "low", "lib", "low-dup", "Alpha", Some("same"));
        insert_projection(&store, "low", "lib", "low-unique", "Bravo", Some("other"));
        let response = browse(&store, &request(vec![
            LibraryScopePair { server_id: "high".into(), library_id: Some("lib".into()) },
            LibraryScopePair { server_id: "low".into(), library_id: Some("lib".into()) },
        ], 10, None)).unwrap();

        assert_eq!(
            response.albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(),
            vec!["low-unique", "high-dup"],
        );
    }

    #[test]
    fn album_priority_dedup_holds_across_cursor_pages() {
        let store = LibraryStore::open_in_memory();
        insert_projection(&store, "high", "lib", "high-dup", "Zulu", Some("same"));
        insert_projection(&store, "low", "lib", "low-dup", "Alpha", Some("same"));
        insert_projection(&store, "low", "lib", "low-unique", "Bravo", Some("other"));
        let scopes = vec![
            LibraryScopePair { server_id: "high".into(), library_id: Some("lib".into()) },
            LibraryScopePair { server_id: "low".into(), library_id: Some("lib".into()) },
        ];

        let first = browse(&store, &request(scopes.clone(), 1, None)).unwrap();
        assert_eq!(first.albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(), vec!["low-unique"]);
        let second = browse(&store, &request(scopes, 1, first.next_cursor)).unwrap();
        assert_eq!(second.albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(), vec!["high-dup"]);
    }

    #[test]
    fn cursor_keeps_each_scope_position_without_skipping_tied_global_order() {
        let store = LibraryStore::open_in_memory();
        insert_projection(&store, "a", "lib", "a-bravo", "Bravo", Some("a-bravo"));
        insert_projection(&store, "a", "lib", "a-delta", "Delta", Some("a-delta"));
        insert_projection(&store, "b", "lib", "b-alpha", "Alpha", Some("b-alpha"));
        insert_projection(&store, "b", "lib", "b-charlie", "Charlie", Some("b-charlie"));
        let scopes = vec![
            LibraryScopePair { server_id: "a".into(), library_id: Some("lib".into()) },
            LibraryScopePair { server_id: "b".into(), library_id: Some("lib".into()) },
        ];

        let first = browse(&store, &request(scopes.clone(), 2, None)).unwrap();
        assert_eq!(
            first.albums.iter().map(|album| album.name.as_str()).collect::<Vec<_>>(),
            vec!["Alpha", "Bravo"],
        );
        let second = browse(&store, &request(scopes, 2, first.next_cursor)).unwrap();
        assert_eq!(
            second.albums.iter().map(|album| album.name.as_str()).collect::<Vec<_>>(),
            vec!["Charlie", "Delta"],
        );
    }

    #[test]
    fn track_priority_scope_wins_even_when_its_duplicate_sorts_later() {
        let store = LibraryStore::open_in_memory();
        insert_track(&store, "high", "lib", "high-dup", "Same", Some("same"));
        insert_track(&store, "low", "lib", "low-dup", "Same", Some("same"));
        insert_track(&store, "low", "lib", "low-unique", "Bravo", Some("other"));
        let response = browse(&store, &track_request(vec![
            LibraryScopePair { server_id: "high".into(), library_id: Some("lib".into()) },
            LibraryScopePair { server_id: "low".into(), library_id: Some("lib".into()) },
        ], 10, None)).unwrap();

        assert_eq!(
            response.tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(),
            vec!["low-unique", "high-dup"],
        );
    }

    #[test]
    fn track_cursor_keeps_each_scope_position_without_skipping_tied_global_order() {
        let store = LibraryStore::open_in_memory();
        insert_track(&store, "a", "lib", "a-bravo", "Bravo", None);
        insert_track(&store, "a", "lib", "a-delta", "Delta", None);
        insert_track(&store, "b", "lib", "b-alpha", "Alpha", None);
        insert_track(&store, "b", "lib", "b-charlie", "Charlie", None);
        let scopes = vec![
            LibraryScopePair { server_id: "a".into(), library_id: Some("lib".into()) },
            LibraryScopePair { server_id: "b".into(), library_id: Some("lib".into()) },
        ];

        let first = browse(&store, &track_request(scopes.clone(), 2, None)).unwrap();
        assert_eq!(
            first.tracks.iter().map(|track| track.title.as_str()).collect::<Vec<_>>(),
            vec!["Alpha", "Bravo"],
        );
        let second = browse(&store, &track_request(scopes, 2, first.next_cursor)).unwrap();
        assert_eq!(
            second.tracks.iter().map(|track| track.title.as_str()).collect::<Vec<_>>(),
            vec!["Charlie", "Delta"],
        );
    }

    #[test]
    fn track_priority_dedup_holds_across_cursor_pages() {
        let store = LibraryStore::open_in_memory();
        insert_track(&store, "high", "lib", "high-dup", "Same", Some("same"));
        insert_track(&store, "low", "lib", "low-dup", "Same", Some("same"));
        let scopes = vec![
            LibraryScopePair { server_id: "high".into(), library_id: Some("lib".into()) },
            LibraryScopePair { server_id: "low".into(), library_id: Some("lib".into()) },
        ];

        let candidates = vec![
            query_track_scope_candidates(&store, &scopes[0], 0, None, 10).unwrap(),
            query_track_scope_candidates(&store, &scopes[1], 1, None, 10).unwrap(),
        ];
        assert_eq!(track_identity_priorities(&store, &scopes, &candidates).unwrap().get("same:20:0"), Some(&0));

        let first = browse(&store, &track_request(scopes.clone(), 1, None)).unwrap();
        assert_eq!(first.tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(), vec!["high-dup"]);
        let second = browse(&store, &track_request(scopes, 1, first.next_cursor)).unwrap();
        assert!(second.tracks.is_empty());
        assert!(!second.has_more);
    }

    #[test]
    fn same_server_occurrence_ranks_survive_across_cursor_pages() {
        let store = LibraryStore::open_in_memory();
        insert_track(&store, "s1", "lib-a", "chapter-1", "Tyrion", Some("tyrion"));
        insert_track(&store, "s1", "lib-b", "chapter-2", "Tyrion", Some("tyrion"));
        store
            .with_conn_mut("test.scope_browse.rank", |conn| {
                conn.execute(
                    "UPDATE cluster.track_cluster_key SET occurrence_rank = 1 \
                     WHERE server_id = 's1' AND track_id = 'chapter-2'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let scopes = vec![
            LibraryScopePair { server_id: "s1".into(), library_id: Some("lib-a".into()) },
            LibraryScopePair { server_id: "s1".into(), library_id: Some("lib-b".into()) },
        ];

        let first = browse(&store, &track_request(scopes.clone(), 1, None)).unwrap();
        assert_eq!(first.tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(), vec!["chapter-1"]);
        let second = browse(&store, &track_request(scopes, 1, first.next_cursor)).unwrap();
        assert_eq!(second.tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(), vec!["chapter-2"]);
    }
}
