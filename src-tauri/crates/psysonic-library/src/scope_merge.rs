//! Merged, priority-deduped reads over an ordered `(server_id, library_id)` scope
//! (multi-library filter WO-4). Joins `track` with the attached `cluster.track_cluster_key`
//! table and keeps the lowest `priority_rank` winner per identity key.

mod album_browse;
mod album_detail;
mod artist_albums;
mod artist_browse;
mod artist_candidates;
mod artist_detail;
mod artist_tracks;
mod browse_lists;
mod common;
mod entity_sources;
mod live_search;
mod track_browse;

#[cfg(test)]
use common::{keyed_detail_track_source, scoped_track_join};

pub use album_detail::album_detail;
pub use artist_detail::artist_detail;
pub use browse_lists::{list_albums, list_artists};
pub use entity_sources::resolve_entity_sources;
pub use live_search::search_tracks;

pub(crate) use album_browse::list_albums_layer1_filtered;
#[allow(unused_imports)]
pub(crate) use artist_browse::{
    list_artists_layer1_filtered, list_index_artists_layer1_filtered,
    list_index_artists_multi_scope_album_filtered, LAYER1_ARTIST_CREDIT_JOIN_SQL,
};
#[allow(unused_imports)]
pub(crate) use artist_candidates::{album_artist_id_expr, AlbumSplitMeta};
#[allow(unused_imports)]
pub(crate) use common::{
    album_row_to_dto, ensure_cluster_keys_for_scopes, finish_scope_album_list, non_empty_scopes,
    normalize_scope_pairs, random_window_offset, scope_cte_sql, AlbumListRow, ALBUM_DEDUP_KEY,
    ALBUM_PICK_KEY, TRACK_CLUSTER_PARTITION_KEY, TRACK_DEDUP_KEY,
};
#[allow(unused_imports)]
pub(crate) use entity_sources::{lookup_album_key, LOOKUP_ALBUM_KEY_SQL};
pub(crate) use live_search::{live_search_albums, live_search_artists, live_search_songs};
pub(crate) use track_browse::{
    collect_scope_fts_rowids, list_albums_filtered, list_artists_filtered, list_tracks_filtered,
    list_tracks_layer1_filtered, search_tracks_filtered,
};

#[cfg(test)]
mod tests {
    include!("scope_merge/tests/support.rs");
    include!("scope_merge/tests/scope_sources.rs");
    include!("scope_merge/tests/artist_release.rs");
    include!("scope_merge/tests/album_credit.rs");
    include!("scope_merge/tests/artist_va.rs");
    include!("scope_merge/tests/artist_appears_cards.rs");
    include!("scope_merge/tests/artist_appears_scope.rs");
    include!("scope_merge/tests/browse_merge.rs");
    include!("scope_merge/tests/album_detail_ordering.rs");
    include!("scope_merge/tests/album_detail_metadata.rs");
    include!("scope_merge/tests/album_detail_identity.rs");
    include!("scope_merge/tests/query_plans.rs");
    include!("scope_merge/tests/perf_probes.rs");
}
