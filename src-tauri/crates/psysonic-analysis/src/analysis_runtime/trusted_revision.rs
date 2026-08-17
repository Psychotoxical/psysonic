use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use psysonic_core::track_enrichment::TrackEnrichmentOutcome;
use tauri::Manager;

use super::cpu_seed::{seed_key, seed_revision_key};
use crate::analysis_cache;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TrustedRevisionGeneration {
    pub(super) revision: String,
    pub(super) generation: u64,
}

#[derive(Default)]
pub(super) struct TrustedActivationState {
    pub(super) current_by_track: HashMap<String, TrustedRevisionGeneration>,
}

impl TrustedActivationState {
    pub(super) fn register(&mut self, key: String, revision: &str, generation: u64) -> u64 {
        if let Some(current) = self.current_by_track.get(&key) {
            if current.revision == revision {
                return current.generation;
            }
            if current.generation > generation {
                return generation;
            }
        }
        self.current_by_track.insert(
            key,
            TrustedRevisionGeneration {
                revision: revision.to_string(),
                generation,
            },
        );
        generation
    }
}

pub(super) static TRUSTED_ACTIVATION_GENERATION: AtomicU64 = AtomicU64::new(0);
pub(super) static TRUSTED_ACTIVATIONS: OnceLock<Mutex<TrustedActivationState>> = OnceLock::new();
pub(super) type TrustedAnalysisFetchWaiter = tokio::sync::oneshot::Sender<()>;
pub(super) static TRUSTED_ANALYSIS_FETCHES: OnceLock<
    Mutex<HashMap<String, Vec<TrustedAnalysisFetchWaiter>>>,
> = OnceLock::new();

#[derive(Debug)]
pub struct TrustedAnalysisFetchPermit {
    key: String,
    waited: bool,
}

impl TrustedAnalysisFetchPermit {
    pub fn waited(&self) -> bool {
        self.waited
    }
}

impl Drop for TrustedAnalysisFetchPermit {
    fn drop(&mut self) {
        let waiters = TRUSTED_ANALYSIS_FETCHES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key)
            .unwrap_or_default();
        for waiter in waiters {
            let _ = waiter.send(());
        }
    }
}

pub async fn reserve_trusted_analysis_fetch(
    server_id: &str,
    track_id: &str,
    revision: &str,
) -> TrustedAnalysisFetchPermit {
    let canonical_track_id = track_id.strip_prefix("stream:").unwrap_or(track_id);
    let key = seed_revision_key(server_id, canonical_track_id, revision);
    let mut waited = false;
    loop {
        let receiver = {
            let mut reservations = TRUSTED_ANALYSIS_FETCHES
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(waiters) = reservations.get_mut(&key) {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                waiters.push(sender);
                Some(receiver)
            } else {
                reservations.insert(key.clone(), Vec::new());
                return TrustedAnalysisFetchPermit { key, waited };
            }
        };
        let _ = receiver
            .expect("occupied fetch must provide a waiter")
            .await;
        waited = true;
    }
}

pub(super) fn canonical_activation_key(server_id: &str, track_id: &str) -> String {
    let canonical_track_id = track_id.strip_prefix("stream:").unwrap_or(track_id);
    seed_key(server_id, canonical_track_id)
}

pub(super) fn next_trusted_generation() -> u64 {
    TRUSTED_ACTIVATION_GENERATION.fetch_add(1, Ordering::Relaxed) + 1
}

pub(super) fn register_trusted_revision_generation(
    server_id: &str,
    track_id: &str,
    revision: &str,
    generation: u64,
) -> u64 {
    let key = canonical_activation_key(server_id, track_id);
    let mut state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state.register(key, revision, generation)
}

#[cfg(test)]
pub(super) fn trusted_revision_generation_is_current(
    server_id: &str,
    track_id: &str,
    revision: &str,
    generation: u64,
) -> bool {
    let key = canonical_activation_key(server_id, track_id);
    TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .current_by_track
        .get(&key)
        .is_some_and(|current| current.revision == revision && current.generation == generation)
}

pub fn begin_trusted_revision(server_id: &str, track_id: &str, revision: &str) -> u64 {
    let key = canonical_activation_key(server_id, track_id);
    let mut state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(current) = state.current_by_track.get(&key) {
        if current.revision == revision {
            return current.generation;
        }
    }
    let generation = next_trusted_generation();
    state.current_by_track.insert(
        key,
        TrustedRevisionGeneration {
            revision: revision.to_string(),
            generation,
        },
    );
    generation
}
/// Activate a trusted revision only while it is still the latest registered
/// revision for the canonical `(server, track)`. The guard remains locked
/// across content-hash repair and variant purge so reverse completions cannot
/// interleave their destructive activation steps.
pub(super) fn activate_trusted_identity<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cache_server_id: &str,
    content_hash_server_id: &str,
    track_id: &str,
    content_hash: &str,
    generation: u64,
) -> bool {
    if cache_server_id.is_empty() {
        return false;
    }
    let activation_key = canonical_activation_key(cache_server_id, track_id);
    let state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let current = state.current_by_track.get(&activation_key);
    let is_current = current.is_some_and(|current| {
        current.revision == content_hash && current.generation == generation
    });

    let key = analysis_cache::TrackKey {
        server_id: cache_server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: content_hash.to_string(),
    };
    if !is_current {
        let superseded_by_other_revision =
            current.is_some_and(|current| current.revision != content_hash);
        if superseded_by_other_revision {
            if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
                match cache.delete_fingerprint(&key) {
                    Ok(n) if n > 0 => crate::app_deprintln!(
                        "[analysis] discarded {n} stale trusted rows track_id={track_id} hash={content_hash}"
                    ),
                    Ok(_) => {}
                    Err(e) => {
                        crate::app_eprintln!("[analysis] stale trusted cleanup failed: {e}")
                    }
                }
            }
        }
        return false;
    }

    if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
        match cache.delete_other_fingerprints(&key) {
            Ok(n) if n > 0 => crate::app_deprintln!(
                "[analysis] trusted activation purged {n} stale fingerprint rows track_id={track_id}"
            ),
            Ok(_) => {}
            Err(e) => {
                crate::app_eprintln!("[analysis] trusted activation purge failed: {e}");
                return false;
            }
        }
    }
    if let Some(sink) = app.try_state::<psysonic_core::ports::ContentHashSink>() {
        sink.record_content_hash(content_hash_server_id, track_id, content_hash);
    }
    true
}

pub(super) fn activate_trusted_enrichment<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cache_server_id: &str,
    content_hash_server_id: &str,
    track_id: &str,
    content_hash: &str,
    generation: u64,
    outcome: TrackEnrichmentOutcome,
) -> bool {
    if matches!(
        outcome,
        TrackEnrichmentOutcome::Failed | TrackEnrichmentOutcome::SkippedSuperseded
    ) {
        return false;
    }
    activate_trusted_identity(
        app,
        cache_server_id,
        content_hash_server_id,
        track_id,
        content_hash,
        generation,
    )
}

pub(crate) fn commit_trusted_enrichment_if_current<T>(
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    generation: u64,
    commit: impl FnOnce() -> T,
) -> Option<T> {
    let activation_key = canonical_activation_key(server_id, track_id);
    let state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let is_current = state
        .current_by_track
        .get(&activation_key)
        .is_some_and(|current| {
            current.revision == content_hash && current.generation == generation
        });
    is_current.then(commit)
}
