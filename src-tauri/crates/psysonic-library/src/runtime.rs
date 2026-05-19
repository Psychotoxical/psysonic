//! `LibraryRuntime` — Tauri State shared by every library command.
//! PR-5a holds only the `LibraryStore`; PR-5b extends with the sync
//! session map, playback hint, supervisor handle, and scheduler
//! cancellation flag.

use std::sync::Arc;

use crate::store::LibraryStore;

pub struct LibraryRuntime {
    pub store: Arc<LibraryStore>,
}

impl LibraryRuntime {
    pub fn new(store: Arc<LibraryStore>) -> Self {
        Self { store }
    }
}
