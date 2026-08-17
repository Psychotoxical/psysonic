use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use super::artist_candidates::{usable_release_types_expr, AlbumSplitMeta};
use super::common::{
    album_row_to_dto, keyed_detail_track_source, map_album_list_row, scope_cte_sql,
    scoped_track_join, TRACK_DEDUP_KEY,
};
use crate::album_compilation_filter::{compilation_predicate_sql, various_artists_like_sql};
use crate::dto::{LibraryAlbumDto, LibraryScopePair};

/// Returns each of the artist's track-derived albums paired with its
/// [`AlbumSplitMeta`]. The caller uses that plus [`album_credits_artist`] to split
/// own releases from appears-on entries.
pub(super) fn fetch_albums_for_artist_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
    va_mode: bool,
) -> rusqlite::Result<Vec<(LibraryAlbumDto, AlbumSplitMeta)>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let release_types_expr = usable_release_types_expr("tt.raw_json");
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    // "Various Artists" is not a real performer: its compilations are linked to the
    // VA entity only through the `album_artist` string, while each track keeps its
    // own performer `artist_id`. The `artist_key` source therefore finds only the
    // few tracks literally tagged with the VA id, not the hundreds of compilations.
    // When the detail target *is* the VA entity, union a second album source keyed
    // on the VA `album_artist` label so the page shows every compilation. The union
    // feeds the same dedup pipeline, so an album qualifying under both sources is
    // still counted once. `scoped_track` is always defined by `scope_cte_sql`.
    //
    // Track-scoped like the `artist_key` source: a compilation with a few untagged
    // tracks (empty `album_artist`) counts only its VA-tagged tracks in the card's
    // `song_count`, matching how every artist page counts its own tracks. The album
    // still appears, and opening it lists the full track set (album_detail keys on
    // `album_key`), so this stays a card-count nuance rather than a missing album.
    let va_arm = if va_mode {
        format!(
            " UNION ALL \
             SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                    t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                    ck.album_key, s.pr AS pr, {TRACK_DEDUP_KEY} AS track_dedup \
             {va_scoped} AND t.album_id IS NOT NULL AND t.album_id != '' AND {va_pred}",
            va_scoped = scoped_track_join(),
            va_pred = various_artists_like_sql("t.album_artist"),
        )
    } else {
        String::new()
    };
    // Compilation signal (compilation / isCompilation / releaseTypes / a Various
    // Artists credit in the flat columns or raw_json displayArtist). Only used to
    // route to appears-on when the album has *no* album-artist tag — a real
    // album_artist that credits the artist (e.g. their own best-of) keeps the album
    // in the main discography, where the frontend groups it under "Compilation".
    //
    // Scoped like `base` (rejoined through `scoped_track`): an album can exist in a
    // library the user did not select — letting those rows decide the split would
    // move an album out of the discography on evidence from outside the scope.
    //
    // Skipped entirely in `va_mode`: the partition returns every album there, so the
    // per-album EXISTS (up to four JSON probes per track of every compilation in the
    // library) would be parsed and thrown away on the heaviest artist page there is.
    // Every track of the album, whichever physical copy and server it sits on:
    // `physical_albums` (one small row per physical album, already grouped by
    // `album_dedup`) drives, `track` is probed through its `(server_id, album_id)`
    // index. Keyed on `album_dedup` rather than the winning row's `(server_id,
    // album_id)`, so reordering library scopes — which changes which copy wins
    // `rn = 1` but no data — cannot move albums between the two lists.
    //
    // Scope is applied against the two bind-value CTEs directly, NOT by joining
    // `scoped_track` or `scope`. `scoped_track` is a UNION ALL over every track in
    // scope and `CROSS JOIN` pins it as the outer loop, so correlating against it
    // would scan the whole scope once per album instead of one indexed probe; `scope`
    // looks small but derives its whole-server half by aggregating the entire `track`
    // table. `exact_scope`/`whole_scope` are the literal scope rows the caller bound —
    // a handful of values, no table access.
    let album_tracks_from = "FROM physical_albums pa \
           JOIN track ct ON ct.server_id = pa.server_id AND ct.album_id = pa.album_id \
          WHERE ct.deleted = 0 AND pa.album_dedup = p.album_dedup \
            AND (EXISTS (SELECT 1 FROM exact_scope es \
                          WHERE es.server_id = ct.server_id AND es.library_id = ct.library_id) \
              OR EXISTS (SELECT 1 FROM whole_scope ws WHERE ws.server_id = ct.server_id))";
    // `ct`'s scope priority — the best (lowest) rank among the scope rows that admit
    // it. Ordering the whole-album credit by this instead of raw `ct.id` makes the
    // choice agree with the priority winner the album card itself is built from, so a
    // cross-server album whose copies disagree on the album-artist can't be classified
    // by one server's metadata and displayed with another's (finding 5).
    let ct_scope_priority = "(SELECT MIN(pr) FROM ( \
            SELECT es.pr FROM exact_scope es \
              WHERE es.server_id = ct.server_id AND es.library_id = ct.library_id \
            UNION ALL \
            SELECT ws.pr FROM whole_scope ws WHERE ws.server_id = ct.server_id))";
    // The album's own `album_artist` tag — see `AlbumSplitMeta` for why it must come
    // from the whole album rather than the viewed artist's own (often untagged) row.
    // Priority-ordered so it names the same copy the card shows.
    let album_artist_tag = format!(
        "(SELECT TRIM(ct.album_artist) {album_tracks_from} \
            AND TRIM(COALESCE(ct.album_artist, '')) <> '' \
          ORDER BY {ct_scope_priority} ASC, ct.id ASC LIMIT 1)"
    );
    // Compilation signal (compilation / isCompilation / releaseTypes / a Various
    // Artists credit on the track artist or in raw_json displayArtist). Only consulted
    // when the album has *no* album-artist tag — a real album_artist that credits the
    // artist (e.g. their own best-of) keeps the album in the main discography, where
    // the frontend groups it under "Compilation".
    //
    // Computed lazily for exactly that reason: it costs up to four JSON probes per
    // track of the album, and the partition ignores it whenever the tag is present —
    // which is the majority of albums. Skipped entirely in `va_mode`, where the
    // partition keeps every album regardless (the heaviest artist page there is).
    //
    // No album-artist column is passed to the predicate: this branch only runs when
    // no scoped track of the album has a non-empty `album_artist`, so that OR-term
    // could never be true and would cost a `LIKE` per track for nothing.
    // In `va_mode` the partition keeps every album, so neither split input is read —
    // emit constants instead of paying for the per-album probes on the heaviest artist
    // page there is.
    let album_artist_col = if va_mode {
        "NULL"
    } else {
        album_artist_tag.as_str()
    };
    let comp_col = if va_mode {
        "0".to_string()
    } else {
        format!(
            "CASE WHEN {album_artist_tag} IS NOT NULL THEN 0 ELSE \
               EXISTS (SELECT 1 {album_tracks_from} AND {comp_pred}) END",
            comp_pred = compilation_predicate_sql("ct", Some("ct.artist"), None),
        )
    };
    // Displayed credit name. In `va_mode` the VA union already carries the right
    // album-artist label on its own rows, so keep the representative. Otherwise use
    // the priority-consistent whole-album credit — the same value the split classifies
    // on — so an appears-on card shows the album's headliner, not the viewed artist's
    // guest-track performer (findings 2 & 5). The entity that credit *links* to is not
    // selected here: `overlay_album_artist_links` resolves it per physical album once
    // the rows are known, which stays owner-correct across a cross-server dedup.
    let display_album_artist = if va_mode {
        "p.album_artist".to_string()
    } else {
        album_artist_tag.clone()
    };
    let sql = format!(
        "{cte}, \
         base AS ( \
            SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                   t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                   ck.album_key, {priority} AS pr, {TRACK_DEDUP_KEY} AS track_dedup \
            {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
            {va_arm} \
          ), \
          physical_albums AS ( \
            SELECT server_id, album_id, \
                   CASE WHEN COUNT(*) = COUNT(album_key) AND COUNT(DISTINCT album_key) = 1 \
                        THEN MIN(album_key) \
                        ELSE ('physical:' || LENGTH(server_id) || ':' || server_id || ':' || album_id) END AS album_dedup \
            FROM base GROUP BY server_id, album_id \
          ), \
          physical_tracks AS ( \
            SELECT b.*, physical_albums.album_dedup \
            FROM base b \
            INNER JOIN physical_albums \
              ON physical_albums.server_id = b.server_id AND physical_albums.album_id = b.album_id \
          ), \
          deduped_tracks AS ( \
            SELECT *, ROW_NUMBER() OVER (PARTITION BY album_dedup, track_dedup ORDER BY pr ASC, id ASC) AS trn \
            FROM physical_tracks \
         ), \
         album_stats AS ( \
           SELECT album_dedup, COUNT(*) AS song_count, SUM(duration_sec) AS duration_total \
           FROM deduped_tracks WHERE trn = 1 GROUP BY album_dedup \
         ), \
         album_pick AS ( \
           SELECT b.server_id, b.album_id, b.album, b.artist, b.artist_id, b.album_artist, \
                  b.year, b.genre, b.cover_art_id, b.starred_at, b.synced_at, b.album_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY b.album_dedup ORDER BY b.pr ASC, b.album_id ASC, b.id ASC) AS rn \
            FROM physical_tracks b \
         ) \
         SELECT p.server_id, p.album_id, p.album, p.artist, p.artist_id, \
                {display_album_artist} AS album_artist, \
                st.song_count, st.duration_total, p.year, p.genre, p.cover_art_id, p.starred_at, p.synced_at, \
                (SELECT {release_types_expr} \
                   FROM track tt \
                  WHERE tt.server_id = p.server_id AND tt.album_id = p.album_id AND tt.deleted = 0 \
                    AND {release_types_expr} IS NOT NULL \
                  ORDER BY tt.id ASC \
                  LIMIT 1) AS release_types, \
                {album_artist_col} AS album_album_artist, \
                {comp_col} AS is_compilation \
         FROM album_pick p \
         INNER JOIN album_stats st ON p.album_dedup = st.album_dedup \
         WHERE p.rn = 1 \
         ORDER BY p.album COLLATE NOCASE ASC",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    // The bulk album pipeline keeps album `raw_json` NULL and the standalone album
    // table is unused, so the DTO would otherwise carry no `releaseTypes` and the
    // artist page could no longer group releases (Albums / Singles / EPs / Live /
    // Compilations) — it collapses to one flat list. Two ingest paths store the
    // MusicBrainz RELEASETYPE tag differently: Navidrome-native rows keep it per
    // track under `raw_json.tags.releasetype`, while the OpenSubsonic/S2 crawl copies
    // the album-level array onto each track at top-level `raw_json.releaseTypes`
    // (see `merge_album_open_subsonic_track_raw`). `usable_release_types_expr` picks a
    // validated array (`release_types`, column 13); reuse the shared album mapper and
    // attach it, so there is one album-DTO construction path.
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            // The card's credit name comes from the representative row; which entity
            // that credit links to is resolved from the whole physical album by
            // `overlay_album_artist_links` once the page's rows are known.
            let mut dto = album_row_to_dto(map_album_list_row(r)?);
            // Attach the validated release-types array (column 13). SQL already
            // guarantees a non-empty array of strings, or NULL; the client-side
            // re-check is a cheap invariant guard, not new filtering.
            dto.raw_json = r
                .get::<_, Option<String>>(13)?
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
                .map(|types| {
                    let mut obj = serde_json::Map::new();
                    obj.insert("releaseTypes".to_string(), types);
                    Value::Object(obj)
                })
                .unwrap_or(Value::Null);
            // Split inputs ride along on the same row (columns 14/15) so the caller
            // can route own releases vs. appears-on without a second query.
            Ok((
                dto,
                AlbumSplitMeta {
                    // No second emptiness test here: SQL already decided what counts as
                    // a tag (`TRIM(...) <> ''`), and SQLite's TRIM strips only spaces
                    // while Rust's `str::trim` strips all Unicode whitespace. Re-testing
                    // would let a tab-tagged album be "tagged" for the compilation
                    // short-circuit in SQL and "untagged" for the partition in Rust.
                    album_artist: r.get::<_, Option<String>>(14)?,
                    is_compilation: r.get::<_, bool>(15)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
