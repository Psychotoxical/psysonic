use reqwest::Client;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Semaphore};

/// Cap concurrent cover HTTP fetches for visible UI routes (library backfill uses its own pool).
pub(super) const COVER_HTTP_CONCURRENCY: usize = 16;
/// UI-visible decode + WebP encode (grid, hero, player) — not shared with library backfill.
pub(super) const COVER_CPU_UI_CONCURRENCY: usize = 2;
/// Library backfill encode ladder — separate pool so bulk warm-up cannot starve the webview.
/// Default only; runtime-tunable from the perf probe via `set_backfill_cpu_parallel`.
const COVER_CPU_BACKFILL_CONCURRENCY: usize = 2;
/// Upper bound for the runtime encode-pool knob (matches the worker cap).
const COVER_CPU_BACKFILL_MAX: usize = 16;
/// External providers (fanart.tv) get their own low-concurrency HTTP lane so
/// they can never starve Navidrome cover / getArtistInfo2 fetches (§26).
const FANART_HTTP_CONCURRENCY: usize = 4;

pub struct CoverCacheState {
    pub root: PathBuf,
    pub client: Client,
    pub max_bytes: u64,
    pub high_watermark_pct: u64,
    pub resume_watermark_pct: u64,
    pub http_sem: Arc<Semaphore>,
    pub cover_cpu_ui_sem: Arc<Semaphore>,
    pub cover_cpu_backfill_sem: Arc<Semaphore>,
    /// External-provider (fanart.tv) HTTP lane — separate from `http_sem` so
    /// external fetches never starve Navidrome cover / getArtistInfo2 (§26).
    pub fanart_http_sem: Arc<Semaphore>,
    /// MusicBrainz name→MBID lane — a single permit, so the §19 resolver runs
    /// strictly serially and the caller's ≥1s spacing keeps us under MB's rate
    /// limit (their ToS).
    pub musicbrainz_sem: Arc<Semaphore>,
    /// Live permit count of `cover_cpu_backfill_sem` (the semaphore itself only
    /// exposes *available* permits, not the configured ceiling).
    cover_cpu_backfill_max: AtomicUsize,
}

impl CoverCacheState {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            client,
            max_bytes: 10 * 1024 * 1024 * 1024,
            high_watermark_pct: 90,
            resume_watermark_pct: 85,
            http_sem: Arc::new(Semaphore::new(COVER_HTTP_CONCURRENCY)),
            cover_cpu_ui_sem: Arc::new(Semaphore::new(COVER_CPU_UI_CONCURRENCY)),
            cover_cpu_backfill_sem: Arc::new(Semaphore::new(COVER_CPU_BACKFILL_CONCURRENCY)),
            fanart_http_sem: Arc::new(Semaphore::new(FANART_HTTP_CONCURRENCY)),
            musicbrainz_sem: Arc::new(Semaphore::new(1)),
            cover_cpu_backfill_max: AtomicUsize::new(COVER_CPU_BACKFILL_CONCURRENCY),
        })
    }

    /// Current configured ceiling of the backfill encode pool.
    pub fn cover_backfill_cpu_parallel(&self) -> usize {
        self.cover_cpu_backfill_max.load(Ordering::Relaxed).max(1)
    }

    /// Retune the backfill encode pool to match the worker's download
    /// concurrency. Grows/shrinks the semaphore permits in place.
    pub fn set_backfill_cpu_parallel(&self, threads: usize) {
        let next = threads.clamp(1, COVER_CPU_BACKFILL_MAX);
        let prev = self.cover_cpu_backfill_max.swap(next, Ordering::SeqCst);
        if next > prev {
            self.cover_cpu_backfill_sem.add_permits(next - prev);
        } else if next < prev {
            let sem = self.cover_cpu_backfill_sem.clone();
            let surplus = prev - next;
            tauri::async_runtime::spawn(async move {
                for _ in 0..surplus {
                    if let Ok(permit) = sem.acquire().await {
                        permit.forget();
                    }
                }
            });
        }
    }

    pub(super) fn cpu_sem_for(&self, library_bulk: bool) -> Arc<Semaphore> {
        if library_bulk {
            self.cover_cpu_backfill_sem.clone()
        } else {
            self.cover_cpu_ui_sem.clone()
        }
    }

    pub(super) fn pressure_from_bytes(&self, _bytes: u64) -> (String, bool) {
        ("ok".into(), true)
    }
}

pub(super) fn state(app: &AppHandle) -> Result<Arc<Mutex<CoverCacheState>>, String> {
    app.try_state::<Arc<Mutex<CoverCacheState>>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "cover cache not initialized".into())
}
