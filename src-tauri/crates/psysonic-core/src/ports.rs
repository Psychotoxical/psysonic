//! Cross-crate port handles.
//!
//! Exists to break the one back-edge in the audio↔analysis dependency:
//! `psysonic-analysis` needs to ask "is this track currently playing?", but
//! must not depend on `psysonic-audio` (which has the real dep on analysis,
//! not the other way around).
//!
//! Implementation note: ports are exposed as **closure handles** rather than
//! `Arc<dyn Trait>` — this avoids forcing every existing `State<AudioEngine>`
//! callsite to switch to `State<Arc<AudioEngine>>` (which Tauri State requires
//! for trait-object registration). The shell crate creates the handle by
//! capturing an `AppHandle` and looking up the audio engine at call time.

use std::sync::Arc;

/// Read-only queries about the live playback session, used by analysis-side
/// code to break the analysis→audio back-edge. The shell crate constructs an
/// instance with two closures (each capturing an `AppHandle`) and registers it
/// as Tauri State; `psysonic-analysis` looks it up via `try_state::<…>()`.
///
/// The closures are independent so each can be a no-op / always-false fallback
/// without coupling the other.
#[derive(Clone)]
pub struct PlaybackQueryHandle {
    is_playing: Arc<dyn Fn(&str) -> bool + Send + Sync + 'static>,
    should_defer_backfill: Arc<dyn Fn(&str) -> bool + Send + Sync + 'static>,
}

impl PlaybackQueryHandle {
    pub fn new<P, D>(is_playing: P, should_defer_backfill: D) -> Self
    where
        P: Fn(&str) -> bool + Send + Sync + 'static,
        D: Fn(&str) -> bool + Send + Sync + 'static,
    {
        Self {
            is_playing: Arc::new(is_playing),
            should_defer_backfill: Arc::new(should_defer_backfill),
        }
    }

    /// `true` if `track_id` is the track currently being decoded/played.
    pub fn is_track_currently_playing(&self, track_id: &str) -> bool {
        (self.is_playing)(track_id)
    }

    /// `true` if a ranged HTTP playback for `track_id` is mid-flight and will
    /// seed analysis on completion — the backfill enqueue should defer.
    pub fn ranged_loudness_backfill_should_defer(&self, track_id: &str) -> bool {
        (self.should_defer_backfill)(track_id)
    }
}

/// Bridge for the analysis→library back-edge (E2 content_hash): when the
/// analysis pipeline has the playback-derived `md5_16kb` for a track, it records
/// it as `track.content_hash` in the library DB. `psysonic-analysis` must not
/// depend on `psysonic-library`, so the shell crate registers a closure that
/// captures an `AppHandle` and patches the library; analysis looks this handle
/// up via `try_state::<…>()` and fires it after a successful seed.
///
/// The patch is a no-op when the library has no row for `(server_id, track_id)`
/// (index off for that server), so the sink is safe to call unconditionally.
type RecordContentHashFn = Arc<dyn Fn(&str, &str, &str) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct ContentHashSink {
    record: RecordContentHashFn,
}

impl ContentHashSink {
    pub fn new<F>(record: F) -> Self
    where
        F: Fn(&str, &str, &str) + Send + Sync + 'static,
    {
        Self { record: Arc::new(record) }
    }

    /// Record `md5_16kb` as the library `content_hash` for `(server_id, track_id)`.
    /// Best-effort: the registered closure swallows errors and no-ops when the
    /// library has no matching row.
    pub fn record_content_hash(&self, server_id: &str, track_id: &str, md5_16kb: &str) {
        (self.record)(server_id, track_id, md5_16kb)
    }
}

/// Library→analysis readiness probe (E3 enrichment): given `(server_id,
/// track_id, md5_16kb)`, returns `(waveform_ready, loudness_ready)` from the
/// analysis cache. `psysonic-library` must not depend on `psysonic-analysis`, so
/// the shell crate registers a closure that captures an `AppHandle`, looks up the
/// `AnalysisCache`, and probes the exact key with a legacy `''` fallback —
/// **read-only, no lazy re-tag**. Library looks this handle up via
/// `try_state::<…>()`; absent handle ⇒ `(false, false)`.
type QueryReadinessFn = Arc<dyn Fn(&str, &str, &str) -> (bool, bool) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct AnalysisReadinessQuery {
    query: QueryReadinessFn,
}

impl AnalysisReadinessQuery {
    pub fn new<F>(query: F) -> Self
    where
        F: Fn(&str, &str, &str) -> (bool, bool) + Send + Sync + 'static,
    {
        Self { query: Arc::new(query) }
    }

    /// `(waveform_ready, loudness_ready)` for `(server_id, track_id, md5_16kb)`.
    pub fn readiness(&self, server_id: &str, track_id: &str, md5_16kb: &str) -> (bool, bool) {
        (self.query)(server_id, track_id, md5_16kb)
    }
}
