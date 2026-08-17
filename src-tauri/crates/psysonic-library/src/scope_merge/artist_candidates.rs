use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use super::common::{keyed_detail_track_source, scope_cte_sql};
use crate::album_compilation_filter::json_guarded;
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::dto::{LibraryArtistDto, LibraryScopePair};

pub(super) fn fetch_artist_candidates(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<Vec<LibraryArtistDto>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    // Display name = the canonical `artist.name` for each (server, artist_id) — the
    // same source the artist browse list uses. Deriving it from the tracks via
    // `MAX(t.artist)` picked up per-track "feat." credits (one guest feature in a
    // discography would rename the whole artist header); `COALESCE` keeps the old
    // track-derived fallback for artist_ids without an indexed artist row.
    let sql = format!(
        "{cte}, \
         grouped AS ( \
           SELECT t.server_id, t.artist_id, \
                  COALESCE( \
                    (SELECT ar.name FROM artist ar \
                      WHERE ar.server_id = t.server_id AND ar.id = t.artist_id), \
                    MAX(t.artist)) AS artist, \
                  COUNT(DISTINCT t.album_id) AS album_count, MAX(t.synced_at) AS synced_at, \
                  MIN({priority}) AS best_pr \
           {scoped} AND t.artist_id IS NOT NULL AND t.artist_id != '' {key_filter} \
           GROUP BY t.server_id, t.artist_id \
         ) \
         SELECT server_id, artist_id, artist, album_count, synced_at, best_pr \
         FROM grouped ORDER BY best_pr ASC",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            let name: String = r.get(2)?;
            Ok(LibraryArtistDto {
                server_id: r.get(0)?,
                id: r.get(1)?,
                name: name.clone(),
                name_sort: Some(sort_key_for_display_name(&name, DEFAULT_IGNORED_ARTICLES)),
                album_count: Some(r.get(3)?),
                synced_at: r.get(4)?,
                raw_json: Value::Null,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn merge_optional_text(dst: &mut String, src: &str) {
    if dst.trim().is_empty() && !src.trim().is_empty() {
        *dst = src.to_string();
    }
}

fn merge_optional(dst: &mut Option<String>, src: &Option<String>) {
    if dst.as_ref().is_none_or(|s| s.trim().is_empty()) {
        if let Some(s) = src.as_ref().filter(|s| !s.trim().is_empty()) {
            *dst = Some(s.clone());
        }
    }
}

fn merge_optional_i64(dst: &mut Option<i64>, src: Option<i64>) {
    if dst.is_none() {
        *dst = src;
    }
}

/// Caller must pre-sort `candidates` by scope priority (lowest index first).
pub(super) fn merge_artist_by_priority(candidates: &[LibraryArtistDto]) -> LibraryArtistDto {
    let mut out = candidates
        .first()
        .cloned()
        .unwrap_or_else(|| LibraryArtistDto {
            server_id: String::new(),
            id: String::new(),
            name: String::new(),
            name_sort: None,
            album_count: None,
            synced_at: 0,
            raw_json: Value::Null,
        });
    for c in candidates.iter().skip(1) {
        merge_optional_text(&mut out.name, &c.name);
        merge_optional(&mut out.name_sort, &c.name_sort);
        merge_optional_i64(&mut out.album_count, c.album_count);
        if out.synced_at < c.synced_at {
            out.synced_at = c.synced_at;
        }
    }
    out
}

/// SQL expression selecting a track's *usable* release-type array from `raw_json`,
/// or NULL when neither representation is usable. A candidate is usable only when it
/// is a non-empty JSON array whose members are all strings; that check is applied to
/// each representation *before* precedence, so an empty or malformed top-level
/// OpenSubsonic `releaseTypes` (the ingest copies empty album arrays verbatim) cannot
/// suppress a valid Navidrome-native `tags.releasetype`, and a non-string member
/// cannot survive to the frontend, where `ArtistDetail.tsx` lowercases each entry.
/// The top-level API field stays preferred when it is itself usable.
///
/// Wrapped in [`json_guarded`] so a malformed row contributes no release types (and a
/// later valid track still wins) instead of aborting the whole artist-detail query.
pub(super) fn usable_release_types_expr(json_col: &str) -> String {
    let candidate = |path: &str| {
        format!(
            "CASE WHEN json_type({c}, '{p}') = 'array' \
                   AND json_array_length({c}, '{p}') > 0 \
                   AND NOT EXISTS (SELECT 1 FROM json_each({c}, '{p}') je WHERE je.type <> 'text') \
                  THEN json_extract({c}, '{p}') END",
            c = json_col,
            p = path,
        )
    };
    json_guarded(
        json_col,
        &format!(
            "COALESCE({top}, {nested})",
            top = candidate("$.releaseTypes"),
            nested = candidate("$.tags.releasetype"),
        ),
        "NULL",
    )
}

/// The server's album-artist id from a track's `raw_json.albumArtistId`, guarded the
/// same way as [`usable_release_types_expr`]: JSON1 raises `malformed JSON` on invalid
/// TEXT, and `track.raw_json` is unconstrained, so one bad row would otherwise abort
/// the whole query instead of contributing nothing.
pub(crate) fn album_artist_id_expr(json_col: &str) -> String {
    format!(
        "CASE WHEN json_valid({c}) \
              THEN CASE WHEN json_type({c}, '$.albumArtistId') = 'text' \
                        THEN json_extract({c}, '$.albumArtistId') END \
              END",
        c = json_col,
    )
}

/// Split inputs for one of the artist's track-derived albums: whether any track
/// carries an OpenSubsonic/Navidrome compilation signal, and whether the album has
/// a real album-artist tag (vs. an S2 ingest where the display credit falls back to
/// the track artist). The caller feeds both to [`album_credits_artist`] to route own
/// releases (main discography) from appears-on entries.
pub(crate) struct AlbumSplitMeta {
    pub is_compilation: bool,
    /// The album's own `album_artist` tag, read across **all** of the album's scoped
    /// tracks — not just the ones by the artist being viewed. The artist's single
    /// guest track is often the untagged row, so reading the tag off that row alone
    /// would report "no album artist" for an album that is plainly credited to
    /// somebody else, and file it under this artist's discography.
    pub album_artist: Option<String>,
}
