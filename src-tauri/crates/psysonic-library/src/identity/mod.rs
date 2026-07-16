//! Precomputed identity keys for multi-library dedup (spec §3.1).

mod attach;
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
pub use rebuild::{cluster_rebuild_needed, ensure_cluster_keys_built, rebuild_cluster_keys};

pub use keys::{build_track_cluster_keys, TrackClusterKeys};
