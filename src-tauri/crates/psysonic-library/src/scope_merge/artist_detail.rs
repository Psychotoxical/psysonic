use super::artist_albums::fetch_albums_for_artist_key;
use super::artist_candidates::{fetch_artist_candidates, merge_artist_by_priority};
use super::artist_tracks::{
    fetch_scope_deduped_tracks_for_artist_key, fetch_top_tracks_fingerprint,
    fetch_top_tracks_server_id,
};
use super::common::{ensure_cluster_keys_for_all_scopes, non_empty_scopes};
use super::entity_sources::{lookup_artist_key, lookup_artist_name, lookup_artist_row};
use crate::album_compilation_filter::{album_credits_artist, various_artists_label};
use crate::browse_support::overlay_album_artist_links;
use crate::dto::{LibraryScopeArtistDetailRequest, LibraryScopeArtistDetailResponse};
use crate::store::LibraryStore;

/// `library_scope_artist_detail` — resolve anchor → `artist_key`, aggregate albums + tracks.
pub fn artist_detail(
    store: &LibraryStore,
    request: &LibraryScopeArtistDetailRequest,
) -> Result<LibraryScopeArtistDetailResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
    let server_id = request.server_id.trim();
    let artist_id = request.artist_id.trim();
    if server_id.is_empty() || artist_id.is_empty() {
        return Err("server_id and artist_id are required".into());
    }

    store.with_scope_detail_read_conn(|conn| {
        let artist_key = lookup_artist_key(conn, server_id, artist_id)?;
        let mut candidates =
            fetch_artist_candidates(conn, scopes, artist_key.as_deref(), server_id, artist_id)?;
        candidates.sort_by_key(|a| {
            scopes
                .iter()
                .position(|p| p.server_id == a.server_id)
                .unwrap_or(usize::MAX) as i64
        });
        // `va_mode` decides from the anchor's canonical name (a name-only query on the
        // hot path — no `raw_json` parse), falling back to the track-derived header.
        let anchor_name = lookup_artist_name(conn, server_id, artist_id)?;
        let mut artist = merge_artist_by_priority(&candidates);
        let va_mode = anchor_name
            .as_deref()
            .map(various_artists_label)
            .unwrap_or_else(|| various_artists_label(&artist.name));
        // Seed the header from the anchor's own `artist` row ONLY on the VA shape:
        // its compilations attach by `album_artist` label, so no track carries the
        // anchor id and the merged header would have an empty id — which the frontend
        // loader treats as "no result" and discards. A non-VA artist with no in-scope
        // tracks must keep that empty header so the loader's network fallback still
        // fires; seeding it would render a populated-but-album-less page instead. The
        // full-row fetch (with `raw_json` parse) is deferred to exactly this branch.
        // Seed the header from the anchor artist row when a VA page has no candidate
        // tracks (side effect: pushes the row and re-merges). The returned flag is no
        // longer read — the album count is recomputed unconditionally below — but the
        // seeding itself must still happen.
        if candidates.is_empty() && va_mode {
            if let Some(row) = lookup_artist_row(conn, server_id, artist_id)? {
                candidates.push(row);
                artist = merge_artist_by_priority(&candidates);
            }
        }
        // The track-derived album set contains both the artist's own releases and
        // every album they only appear on (Various Artists / curated compilations,
        // other artists' albums with a guest track). Split by the canonical album
        // artist so the frontend can render "appears on" separately from the main
        // discography — locally, so it stays correct under multi-server scopes and
        // needs no network search (the old featured-albums path was network-only
        // and disabled for multi-server).
        let all_albums = fetch_albums_for_artist_key(
            conn,
            scopes,
            artist_key.as_deref(),
            server_id,
            artist_id,
            va_mode,
        )?;
        let (own, appears_on): (Vec<_>, Vec<_>) = all_albums.into_iter().partition(|(_, meta)| {
            // The "Various Artists" pseudo-entity has no discography of its own to
            // separate an appears-on set from: every album on that page *is* a
            // compilation it heads. Splitting there would eject exactly the albums
            // the VA union arm gathered — an id-tagged compilation with an empty
            // `album_artist` carries a compilation signal and would be routed away.
            if va_mode {
                return true;
            }
            // Own = the album credits this artist as its album artist. A single-artist
            // compilation the artist owns (their own best-of, tagged album_artist = the
            // artist) therefore stays in the main discography and lands in the
            // frontend's "Compilation" release-type group.
            match meta.album_artist.as_deref() {
                // Tagged album: the tag is authoritative, so compare against it.
                Some(tag) => album_credits_artist(Some(tag), &artist.name),
                // Untagged album (S2 ingest, or simply untagged files): there is no
                // album-artist claim to weigh, and the album is only in this set
                // because the artist's own tracks carry this artist's `artist_id` —
                // the strongest signal available. Do NOT second-guess that with a name
                // comparison: a server's artist row and its track tag routinely differ
                // in spelling ("Die drei ???" vs "Die Drei Fragezeichen"), which would
                // exile an artist's entire catalogue. Only a compilation signal, which
                // is about the album rather than the spelling, routes it to appears-on.
                None => !meta.is_compilation,
            }
        });
        let mut albums: Vec<_> = own.into_iter().map(|(al, _)| al).collect();
        let mut appears_on_albums: Vec<_> = appears_on.into_iter().map(|(al, _)| al).collect();
        // Resolve each card's album-artist link against the whole physical album, for
        // both halves of the split: an appears-on card is exactly the case where the
        // representative row is the viewed artist's guest track, so its credit would
        // otherwise link to that guest instead of the album's headliner.
        overlay_album_artist_links(conn, &mut albums);
        overlay_album_artist_links(conn, &mut appears_on_albums);
        // Keep the header count and the rendered grid in agreement. The hero renders
        // exactly `albums` (the main discography), so the count is `albums.len()` in
        // every case: a single server, a cross-server union of own releases, a
        // label-linked VA page whose stored count is 0, or a split that moved releases
        // into "appears on". The server/merge-reported value describes the unsplit,
        // single-server set and drifts from the rendered grid in every multi-source or
        // split case, so the recompute is unconditional (finding 4).
        artist.album_count = Some(albums.len() as i64);
        let tracks = if request.include_tracks {
            fetch_scope_deduped_tracks_for_artist_key(
                conn,
                scopes,
                artist_key.as_deref(),
                server_id,
                artist_id,
                request.top_tracks_limit,
            )?
        } else {
            Vec::new()
        };
        let (top_tracks_server_id, top_tracks_fingerprint) = if request.top_tracks_limit.is_some() {
            let source_server_id = fetch_top_tracks_server_id(
                conn,
                scopes,
                artist_key.as_deref(),
                server_id,
                artist_id,
            )?;
            let fingerprint = if source_server_id.is_some() {
                Some(fetch_top_tracks_fingerprint(
                    conn,
                    scopes,
                    artist_key.as_deref(),
                    server_id,
                    artist_id,
                )?)
            } else {
                None
            };
            (source_server_id, fingerprint)
        } else {
            (None, None)
        };
        Ok(LibraryScopeArtistDetailResponse {
            artist,
            albums,
            appears_on_albums,
            tracks,
            top_tracks_server_id,
            top_tracks_fingerprint,
        })
    })
}
