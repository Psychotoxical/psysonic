//! Precomputed identity keys for multi-library dedup (spec §3.1).

mod attach;
mod invalidation;
mod keys;
mod norm;
mod rebuild;

pub use attach::{
    attach_cluster_pair_file, attach_cluster_read_file, attach_cluster_read_memory,
    attach_cluster_write_file, attach_cluster_write_memory, cluster_db_path_for_library,
    remove_cluster_files_for_library, CLUSTER_DB_FILENAME, CLUSTER_SCHEMA,
};
pub use norm::NORM_VERSION;
pub(crate) use norm::norm_part;
pub(crate) use invalidation::{record_album_scopes, record_albums, record_artists, record_tracks};
pub use rebuild::{
    cluster_rebuild_needed, ensure_cluster_keys_built, ensure_pending_cluster_keys,
    identity_maintenance_needed, rebuild_cluster_keys,
};
pub(crate) use rebuild::{
    concrete_physical_album_key, mark_cluster_keys_dirty, prune_cluster_keys_for_scope,
    refresh_library_ids_for_albums,
};

pub use keys::{build_track_cluster_keys, TrackClusterKeys};
pub(crate) use keys::build_album_key_with_version;
