mod ingest;
mod library_tagging;
mod reads;
mod remap;
mod resync;
pub(crate) mod retarget;
mod row;

#[cfg(test)]
mod tests;

use crate::store::LibraryStore;

pub(crate) use row::{row_to_track_row, row_to_track_row_at, track_columns};
pub(crate) use ingest::UPSERT_SQL;
pub use row::{RemapEntry, RemapStats, TrackRow};

pub struct TrackRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> TrackRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }
}
