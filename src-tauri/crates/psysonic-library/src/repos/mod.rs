pub mod artist;
pub mod artifact;
pub mod fact;
pub mod play_session;
pub mod sync_state;
pub mod track;
pub mod track_id_history;

pub use artist::ArtistRepository;
pub use artifact::ArtifactRepository;
pub use fact::FactRepository;
pub use play_session::PlaySessionRepository;
pub use sync_state::SyncStateRepository;
pub use track::{RemapEntry, RemapStats, TrackRepository, TrackRow};
pub use track_id_history::TrackIdHistoryRepository;

// Shared row-mapper + column list so the Advanced Search builder can project
// the same hot columns as the repositories without re-declaring them.
pub(crate) use track::{row_to_track_row, track_columns};
