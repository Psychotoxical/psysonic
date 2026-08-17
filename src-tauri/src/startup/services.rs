use std::sync::Arc;

use tauri::Manager;

use crate::{
    analysis_cache, audio, cover_cache, library_analysis_backfill, library_identity_maintenance,
};

mod library_scheduler;

pub(crate) fn initialize(app: &mut tauri::App) -> Result<(), String> {
    let cache = analysis_cache::AnalysisCache::init(app.handle())
        .map_err(|e| format!("analysis cache init failed: {e}"))?;
    app.manage(cache);

    cover_cache::init_cover_cache(app.handle())
        .map_err(|e| format!("cover cache init failed: {e}"))?;

    library_analysis_backfill::init_library_analysis_backfill(app.handle())
        .map_err(|e| format!("library analysis backfill init failed: {e}"))?;

    let store = psysonic_library::store::LibraryStore::init(app.handle())
        .map_err(|e| format!("library store init failed: {e}"))?;
    let runtime = psysonic_library::LibraryRuntime::new(Arc::new(store));
    app.manage(runtime);
    library_identity_maintenance::setup_library_identity_maintenance(app.handle());
    library_scheduler::spawn(app.handle().clone());

    audio::cleanup_orphan_stream_spill_dir(app.handle());

    let app_is_playing = app.handle().clone();
    let app_defer = app.handle().clone();
    let handle = psysonic_core::ports::PlaybackQueryHandle::new(
        move |track_id| {
            app_is_playing
                .try_state::<crate::audio::AudioEngine>()
                .is_some_and(|e| crate::audio::analysis_track_id_is_current_playback(&e, track_id))
        },
        move |track_id| {
            app_defer
                .try_state::<crate::audio::AudioEngine>()
                .is_some_and(|e| {
                    crate::audio::playback_analysis_backfill_should_defer(&e, track_id)
                })
        },
    );
    app.manage(handle);

    app.manage(psysonic_analysis::analysis_runtime::PlaybackPriorityHints::default());

    let app_for_hash = app.handle().clone();
    let sink = psysonic_core::ports::ContentHashSink::new(
        move |server_id: &str, track_id: &str, md5: &str| {
            if let Some(runtime) = app_for_hash.try_state::<psysonic_library::LibraryRuntime>() {
                let _ = psysonic_library::commands::patch_content_hash(
                    &runtime, server_id, track_id, md5,
                );
            }
        },
    );
    app.manage(sink);

    let app_for_readiness = app.handle().clone();
    let query = psysonic_core::ports::AnalysisReadinessQuery::new(
        move |server_id: &str, track_id: &str, md5: &str| {
            let Some(cache) = app_for_readiness.try_state::<analysis_cache::AnalysisCache>() else {
                return (false, false);
            };
            let probe = |sid: &str| {
                let key = analysis_cache::TrackKey {
                    server_id: sid.to_string(),
                    track_id: track_id.to_string(),
                    md5_16kb: md5.to_string(),
                };
                let wf = cache.get_waveform(&key).ok().flatten().is_some();
                let ld = cache.loudness_row_exists_for_key(&key).unwrap_or(false);
                (wf, ld)
            };
            let (wf, ld) = probe(server_id);
            let wf = wf || (!server_id.is_empty() && probe("").0);
            let ld = ld || (!server_id.is_empty() && probe("").1);
            (wf, ld)
        },
    );
    app.manage(query);

    use psysonic_core::ports::TrackAnalysisNeedsWorkQuery;
    let app_for_needs_work = app.handle().clone();
    let needs_work = TrackAnalysisNeedsWorkQuery::new(move |server_id: &str, track_id: &str| {
        psysonic_analysis::analysis_runtime::track_analysis_needs_work(
            &app_for_needs_work,
            server_id,
            track_id,
        )
    });
    app.manage(needs_work);

    initialize_track_enrichment_port(app);

    tauri::async_runtime::spawn(
        psysonic_analysis::analysis_runtime::analysis_queue_snapshot_loop(),
    );

    Ok(())
}

fn enrichment_now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn initialize_track_enrichment_port(app: &mut tauri::App) {
    use psysonic_core::track_enrichment::{TrackEnrichmentPlan, TrackEnrichmentPort};

    let app_for_enrichment_plan = app.handle().clone();
    let app_for_enrichment_store = app.handle().clone();
    let port = TrackEnrichmentPort::new(
        move |server_id: &str, track_id: &str, content_hash: &str| {
            let Some(runtime) =
                app_for_enrichment_plan.try_state::<psysonic_library::LibraryRuntime>()
            else {
                return TrackEnrichmentPlan::default();
            };
            match psysonic_library::enrichment::plan_track_enrichment(
                &runtime.store,
                server_id,
                track_id,
                content_hash,
                enrichment_now_unix_ms(),
            ) {
                Ok(plan) => plan,
                Err(e) => {
                    eprintln!(
                        "[enrichment] plan failed server_id={server_id} track_id={track_id}: {e}"
                    );
                    TrackEnrichmentPlan {
                        need_bpm: true,
                        need_valence: true,
                        need_arousal: true,
                        need_moods: true,
                    }
                }
            }
        },
        move |server_id: &str,
              track_id: &str,
              content_hash: &str,
              facts: &psysonic_core::track_enrichment::TrackEnrichmentFacts| {
            let Some(runtime) =
                app_for_enrichment_store.try_state::<psysonic_library::LibraryRuntime>()
            else {
                return Err("library runtime unavailable".into());
            };
            psysonic_library::enrichment::store_track_enrichment_facts(
                &runtime.store,
                server_id,
                track_id,
                content_hash,
                facts,
                enrichment_now_unix_ms(),
            )
        },
    );
    app.manage(port);
}
