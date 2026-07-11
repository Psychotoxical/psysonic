// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod cli;
mod cover_cache;
pub(crate) mod library_analysis_backfill;
mod lib_commands;
pub(crate) mod theme_import;
pub mod theme_animation;

pub use psysonic_integration::discord;

pub use psysonic_core::logging;
pub use psysonic_core::{app_eprintln, app_deprintln};
pub use psysonic_core::user_agent::{
    default_subsonic_wire_user_agent, runtime_subsonic_wire_user_agent, subsonic_wire_user_agent,
};
pub use psysonic_analysis::{analysis_cache, analysis_runtime};
pub use psysonic_audio as audio;
pub use psysonic_syncfs::{sync_cancel_flags, DownloadSemaphore};
#[cfg(target_os = "windows")]
mod taskbar_win;
mod tray_runtime;

pub(crate) use tray_runtime::*;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use lib_commands::*;

/// Tracks which user-configured shortcuts are currently registered (shortcut_str → action).
/// Prevents on_shortcut() accumulating duplicate handlers across JS reloads (HMR / StrictMode).
type ShortcutMap = Mutex<HashMap<String, String>>;

/// Maximum number of offline track downloads that can run concurrently.
/// The frontend queues more tasks than this; Rust is the real throttle.
const MAX_DL_CONCURRENCY: usize = 4;

/// Shared handle to OS media controls (MPRIS2 on Linux, Now Playing on macOS, SMTC on Windows).
/// `None` if souvlaki failed to initialize (e.g. no D-Bus session on Linux).
type MprisControls = Mutex<Option<souvlaki::MediaControls>>;

/// Release builds only: focus or CLI-hand off when a second instance is launched.
#[cfg(not(debug_assertions))]
fn on_second_instance<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    argv: Vec<String>,
    _cwd: String,
) {
    if !crate::cli::handle_cli_on_primary_instance(app, &argv) {
        let window = app.get_webview_window("main").expect("no main window");
        // The window may have been hidden via the close-to-tray path,
        // which injects PAUSE_RENDERING_JS (sets `__psyHidden=true`,
        // pauses CSS animations). Tray-icon restore mirrors this with
        // RESUME_RENDERING_JS — second-launch restore must do the same,
        // otherwise the webview comes back with rendering still paused
        // and navigation looks blank (issue #497).
        let _ = window.eval(RESUME_RENDERING_JS);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Windows: associate this process with an explicit AppUserModelID. Windows uses
/// it to name the app in taskbar grouping and the SMTC media controls; without it
/// the media tile reads "Unknown application". Must match the AppUserModelID the
/// installer sets on the Start-menu shortcut so the name/icon resolve.
#[cfg(target_os = "windows")]
fn set_app_user_model_id() {
    use windows::core::w;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    // SAFETY: a Win32 call with a static wide string; errors are non-fatal.
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(w!("dev.psysonic.player"));
    }
}

/// FE↔BE contract via tauri-specta. The builder collects `#[specta::specta]`
/// commands and exports typed TS bindings; the existing `generate_handler!` stays
/// the live invoke handler (no cutover yet). Export runs only in debug builds /
/// tests, so a specta RC break can never block a release `cargo build` — the
/// committed `bindings.ts` is plain TypeScript for `tsc`. Grow `collect_commands!`
/// crate-by-crate (see the specta-contract plan).
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        // Map Rust `i64`/`u64`/`usize`/… to TS `number` globally. This is
        // behaviour-preserving, NOT a change: Tauri already serialises these as
        // JSON numbers and the hand-written FE DTOs already type them `number`
        // (with the same >2^53 truncation JSON.parse does today). The flag only
        // makes the generated types match that reality — it avoids ~200 per-field
        // `#[specta(type = Number)]` casts across the DTOs. `enable_lossless_bigints`
        // (→ TS `bigint`) is the real behaviour change and stays rejected.
        //
        // Bigint precision audit (Option-A guard, done 2026-07-02): every returned
        // i64/u64 field across the collected DTOs is an epoch-ms timestamp (~1e13),
        // a catalog/play count (~1e7), a byte size (~1e13 for a large library) or a
        // tiny scalar (year, track/disc no., bpm, rating) — all well under 2^53
        // (~9e15). No nanosecond timestamps, no integer-encoded hashes (content_hash
        // is a String), no unbounded accumulators. If a future DTO adds one, model
        // it as a String at the edge instead of relying on this cast.
        .dangerously_cast_bigints_to_number()
        .commands(tauri_specta::collect_commands![
            crate::lib_commands::app_api::core::greet,
            psysonic_library::browse_support::library_get_catalog_year_bounds,
            psysonic_library::browse_support::library_get_genre_album_counts,
            // psysonic-library — remaining typeable commands. Excluded (stay on
            // generate_handler! only): the 10 search/browse/track reads whose envelopes
            // carry LibraryTrack/Album/ArtistDto (each has `raw_json: Value`, dto.rs) +
            // library_upsert_songs_from_api / library_patch_track (serde_json::Value args).
            psysonic_library::browse_support::library_reconcile_album_stars,
            psysonic_library::commands::library_resolve_cover_entry,
            psysonic_library::commands::library_analysis_backfill_batch,
            psysonic_library::commands::library_analysis_progress,
            psysonic_library::commands::library_count_live_tracks,
            psysonic_library::commands::library_get_status,
            psysonic_library::commands::library_get_artifact,
            psysonic_library::commands::library_get_facts,
            psysonic_library::commands::library_get_offline_path,
            psysonic_library::commands::library_genre_tags_inspect,
            psysonic_library::commands::library_genre_tags_run,
            psysonic_library::commands::library_cluster_rebuild,
            psysonic_library::commands::library_sync_bind_session,
            psysonic_library::commands::library_sync_clear_session,
            psysonic_library::commands::library_set_playback_hint,
            psysonic_library::commands::library_get_playback_hint,
            psysonic_library::commands::library_sync_start,
            psysonic_library::commands::library_sync_verify_integrity,
            psysonic_library::commands::library_sync_cancel,
            psysonic_library::commands::library_put_artifact,
            psysonic_library::commands::library_put_fact,
            psysonic_library::commands::library_record_play_session,
            psysonic_library::commands::library_get_player_stats_year_summary,
            psysonic_library::commands::library_get_player_stats_heatmap,
            psysonic_library::commands::library_get_player_stats_day_detail,
            psysonic_library::commands::library_get_player_stats_year_bounds,
            psysonic_library::commands::library_get_player_stats_recent_days,
            psysonic_library::commands::library_get_recent_play_sessions,
            psysonic_library::commands::library_purge_server,
            psysonic_library::commands::library_migrate_server_index_keys,
            psysonic_library::commands::library_delete_server_data,
            // psysonic-audio (audio_play + audio_chain_preload excluded: >10 args
            // exceed specta's SpectaFn limit — see the note at their definitions)
            audio::transport_commands::audio_pause,
            audio::transport_commands::audio_resume,
            audio::transport_commands::audio_stop,
            audio::transport_commands::audio_seek,
            audio::mix_commands::audio_set_volume,
            audio::mix_commands::audio_update_replay_gain,
            audio::mix_commands::audio_set_eq,
            audio::mix_commands::audio_set_playback_rate,
            audio::mix_commands::audio_set_crossfade,
            audio::mix_commands::audio_set_gapless,
            audio::mix_commands::audio_begin_outgoing_fade,
            audio::mix_commands::audio_set_autodj_suppress,
            audio::mix_commands::audio_set_normalization,
            audio::autoeq_commands::autoeq_entries,
            audio::autoeq_commands::autoeq_fetch_profile,
            audio::preload_commands::audio_preload,
            audio::radio_commands::audio_play_radio,
            audio::preview::audio_preview_play,
            audio::preview::audio_preview_stop,
            audio::preview::audio_preview_stop_silent,
            audio::preview::audio_preview_set_volume,
            audio::device_commands::audio_list_devices,
            audio::device_commands::audio_canonicalize_selected_device,
            audio::device_commands::audio_default_output_device_name,
            audio::device_commands::audio_set_device,
            // psysonic-analysis (no Value / all ≤10 args — fully typeable)
            psysonic_analysis::commands::analysis_get_waveform,
            psysonic_analysis::commands::analysis_get_waveform_for_track,
            psysonic_analysis::commands::analysis_get_loudness_for_track,
            psysonic_analysis::commands::analysis_delete_loudness_for_track,
            psysonic_analysis::commands::analysis_delete_waveform_for_track,
            psysonic_analysis::commands::analysis_delete_all_waveforms,
            psysonic_analysis::commands::analysis_delete_all_for_server,
            psysonic_analysis::commands::analysis_get_failed_track_count,
            psysonic_analysis::commands::analysis_list_failed_tracks,
            psysonic_analysis::commands::analysis_clear_failed_tracks,
            psysonic_analysis::commands::analysis_migrate_server_index_keys,
            psysonic_analysis::commands::analysis_enqueue_seed_from_url,
            psysonic_analysis::commands::analysis_set_playback_priority_hints,
            psysonic_analysis::commands::analysis_set_pipeline_parallelism,
            psysonic_analysis::commands::analysis_get_pipeline_queue_stats,
            psysonic_analysis::commands::analysis_get_backfill_queue_stats,
            psysonic_analysis::commands::analysis_prune_pending_to_track_ids,
            // psysonic-syncfs (calculate_sync_payload + write/read_device_manifest excluded: serde_json::Value)
            psysonic_syncfs::cache::offline::download_track_offline,
            psysonic_syncfs::cache::offline::cancel_offline_downloads,
            psysonic_syncfs::cache::offline::clear_offline_cancel,
            psysonic_syncfs::cache::offline::delete_offline_track,
            psysonic_syncfs::cache::offline::get_offline_cache_size,
            psysonic_syncfs::cache::local::probe_library_track_local,
            psysonic_syncfs::cache::local::discover_library_tier_on_disk,
            psysonic_syncfs::cache::local::prune_orphan_library_tier_files,
            psysonic_syncfs::cache::local::prune_orphan_ephemeral_cache_files,
            psysonic_syncfs::cache::local::evict_ephemeral_cache_orphans_to_fit,
            psysonic_syncfs::cache::local::probe_media_files,
            psysonic_syncfs::cache::local::get_media_tier_size,
            psysonic_syncfs::cache::local::purge_media_tier,
            psysonic_syncfs::cache::local::delete_media_file,
            psysonic_syncfs::cache::local::prune_empty_media_tier_dirs,
            psysonic_syncfs::cache::local::promote_stream_cache_to_local,
            psysonic_syncfs::cache::local::migrate_legacy_offline_disk,
            psysonic_syncfs::cache::hot::download_track_hot_cache,
            psysonic_syncfs::cache::hot::promote_stream_cache_to_hot_cache,
            psysonic_syncfs::cache::hot::get_hot_cache_size,
            psysonic_syncfs::cache::hot::delete_hot_cache_track,
            psysonic_syncfs::cache::hot::purge_hot_cache,
            psysonic_syncfs::sync::device::sync_track_to_device,
            psysonic_syncfs::sync::batch::sync_batch_to_device,
            psysonic_syncfs::sync::batch::cancel_device_sync,
            psysonic_syncfs::sync::device::compute_sync_paths,
            psysonic_syncfs::sync::batch::list_device_dir_files,
            psysonic_syncfs::sync::batch::delete_device_file,
            psysonic_syncfs::sync::batch::delete_device_files,
            psysonic_syncfs::sync::device::get_removable_drives,
            psysonic_syncfs::sync::device::write_playlist_m3u8,
            psysonic_syncfs::sync::device::rename_device_files,
            psysonic_syncfs::cache::downloads::download_zip,
            psysonic_syncfs::cache::downloads::check_arch_linux,
            psysonic_syncfs::cache::downloads::download_update,
            psysonic_syncfs::cache::downloads::open_folder,
            psysonic_syncfs::cache::downloads::get_embedded_lyrics,
            psysonic_syncfs::cache::downloads::fetch_netease_lyrics,
            // cover_cache (cover_revalidate_batch excluded: returns serde_json::Value)
            cover_cache::cover_cache_peek_batch,
            cover_cache::cover_cache_ensure,
            cover_cache::cover_cache_ensure_batch,
            cover_cache::cover_cache_stats,
            cover_cache::cover_cache_evict_tick,
            cover_cache::cover_cache_configure,
            cover_cache::cover_cache_clear,
            cover_cache::cover_cache_clear_server,
            cover_cache::cover_cache_purge_external,
            cover_cache::cover_cache_rename_server_bucket,
            cover_cache::cover_cache_stats_server,
            cover_cache::cover_cache_get_pipeline_queue_stats,
            cover_cache::library_cover_backfill_batch,
            cover_cache::library_cover_progress,
            cover_cache::library_cover_catalog_size,
            cover_cache::library_cover_clear_fetch_failures,
            cover_cache::library_cover_backfill_configure,
            cover_cache::library_cover_backfill_set_base_url,
            cover_cache::library_cover_backfill_pulse,
            cover_cache::library_cover_backfill_reset_cursor,
            cover_cache::library_cover_backfill_set_ui_priority,
            cover_cache::library_cover_backfill_set_parallel,
            cover_cache::library_cover_backfill_run_full_pass,
            cover_cache::cover_revalidate_enqueue,
            cover_cache::cover_revalidate_tick,
            // top crate shell commands (set_tray_menu_labels >10 args, backup_*_full/cli_publish_* are Value — all excluded)
            crate::lib_commands::app_api::core::exit_app,
            crate::lib_commands::app_api::core::set_logging_mode,
            crate::lib_commands::app_api::core::set_psylab_albums_browse_trace,
            crate::lib_commands::app_api::core::set_psylab_artists_browse_trace,
            crate::lib_commands::app_api::core::get_logging_mode,
            crate::lib_commands::app_api::core::tail_runtime_logs,
            crate::lib_commands::app_api::core::export_runtime_logs,
            crate::lib_commands::app_api::core::frontend_debug_log,
            crate::lib_commands::app_api::core::set_subsonic_wire_user_agent,
            crate::lib_commands::app_api::perf::performance_cpu_snapshot,
            crate::lib_commands::app_api::platform::set_window_decorations,
            crate::lib_commands::app_api::platform::set_linux_webkit_smooth_scrolling,
            crate::lib_commands::app_api::platform::linux_wayland_gpu_font_tuning_active,
            crate::lib_commands::app_api::platform::linux_wayland_text_render_settings_available,
            crate::lib_commands::app_api::platform::set_linux_wayland_text_render_profile,
            crate::lib_commands::app_api::platform::theme_animation_risk,
            crate::lib_commands::app_api::migration::migration_inspect,
            crate::lib_commands::app_api::migration::migration_run,
            crate::lib_commands::app_api::network::resolve_host_addresses,
            crate::lib_commands::app_api::network::probe_server_connection,
            crate::lib_commands::app_api::network::subsonic_proxy_request,
            crate::lib_commands::app_api::network::server_http_context_clear,
            crate::lib_commands::app_api::network::server_http_context_sync,
            crate::lib_commands::app_api::network::server_http_context_sync_all,
            crate::lib_commands::app_api::backup::backup_export_library_db,
            crate::lib_commands::app_api::backup::backup_import_library_db,
            crate::lib_commands::app_api::integration::register_global_shortcut,
            crate::lib_commands::app_api::integration::unregister_global_shortcut,
            crate::lib_commands::app_api::integration::mpris_set_metadata,
            crate::lib_commands::app_api::integration::mpris_set_playback,
            crate::lib_commands::app_api::integration::check_dir_accessible,
            crate::lib_commands::ui::mini::open_mini_player,
            crate::lib_commands::ui::mini::preload_mini_player,
            crate::lib_commands::ui::mini::close_mini_player,
            crate::lib_commands::ui::mini::set_mini_player_always_on_top,
            crate::lib_commands::ui::mini::resize_mini_player,
            crate::lib_commands::ui::mini::show_main_window,
            crate::lib_commands::ui::mini::pause_rendering,
            crate::lib_commands::ui::mini::resume_rendering,
            crate::lib_commands::sync::tray::no_compositing_mode,
            crate::lib_commands::sync::tray::linux_xdg_session_type,
            crate::lib_commands::sync::tray::is_tiling_wm_cmd,
            crate::lib_commands::sync::tray::toggle_tray_icon,
            crate::lib_commands::sync::tray::set_tray_tooltip,
            crate::lib_commands::sync::tray::set_tray_menu_labels,
            crate::theme_import::import_theme_zip,
            crate::library_analysis_backfill::library_analysis_backfill_configure,
            // psysonic-integration — typeable subset. Excluded (stay on generate_handler!):
            // the nd_list_*/nd_create_*/nd_update_* + scrobbler (audioscrobbler/listenbrainz/
            // maloja) + radio-browser + fetch_json_url raw-JSON commands (serde_json::Value /
            // passthrough), and discord_update_presence (>10 args) — noted at their defs.
            psysonic_integration::bandsintown::fetch_bandsintown_events,
            psysonic_integration::navidrome::covers::upload_playlist_cover,
            psysonic_integration::navidrome::covers::upload_radio_cover,
            psysonic_integration::navidrome::covers::upload_artist_image,
            psysonic_integration::navidrome::covers::delete_radio_cover,
            psysonic_integration::navidrome::playlists::nd_delete_playlist,
            psysonic_integration::navidrome::queries::nd_set_user_libraries,
            psysonic_integration::navidrome::queries::nd_get_song_path,
            psysonic_integration::navidrome::users::navidrome_login,
            psysonic_integration::navidrome::users::nd_delete_user,
            psysonic_integration::remote::fetch_url_bytes,
            psysonic_integration::remote::fetch_icy_metadata,
            psysonic_integration::remote::resolve_stream_url,
            psysonic_integration::discord::discord_clear_presence,
        ])
}

/// TS exporter config. Kept as a single seam so the exporter options (header /
/// per-type BigInt-style handling for i64 DTOs) are configured in one place as
/// commands are added crate-by-crate.
fn bindings_exporter() -> specta_typescript::Typescript {
    specta_typescript::Typescript::default()
}

/// Regenerate the committed bindings on a debug launch (matches the dev workflow;
/// the CI freshness gate runs the equivalent export in a test — see `specta_export`).
#[cfg(debug_assertions)]
fn export_specta_bindings() {
    specta_builder()
        .export(bindings_exporter(), "../src/generated/bindings.ts")
        .expect("failed to export typescript bindings");
}

pub fn run() {
    #[cfg(debug_assertions)]
    export_specta_bindings();

    // Windows: bind this process to an explicit AppUserModelID before any window
    // or the SMTC media controls are created, so the OS can resolve the app
    // name/icon for taskbar grouping and the media tile (#1102 follow-up: the
    // Quick-Settings / lock-screen media tile showed "Unknown application").
    #[cfg(target_os = "windows")]
    set_app_user_model_id();

    let (audio_engine, _audio_thread) = audio::create_engine();

    let builder = tauri::Builder::default()
        .manage(audio_engine)
        .manage(Arc::new(psysonic_core::server_http::ServerHttpRegistry::new()))
        .manage(ShortcutMap::default())
        .manage(discord::DiscordState::new())
        .manage(Arc::new(tokio::sync::Semaphore::new(MAX_DL_CONCURRENCY)) as DownloadSemaphore)
        .manage(TrayState::default())
        .manage(TrayTooltip::default())
        .manage(TrayPlaybackState::default())
        .manage(TrayMenuItemsState::default())
        .manage(TrayMenuLabelsState::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_denylist(&["mini"])
                .build()
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(on_second_instance));

    builder
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Psysonic (Dev)");
            }

            // ── Dev: `--theme-watch <theme.css>` live theme reload ─────────
            // Poll a local theme.css and push it into the running app on save,
            // so theme authors get a live loop without re-importing a zip. The
            // frontend (dev only) installs it under the id in its
            // `[data-theme='<id>']` selector and applies it. Dev-builds only.
            #[cfg(debug_assertions)]
            {
                let args: Vec<String> = std::env::args().collect();
                if let Some(i) = args.iter().position(|a| a == "--theme-watch") {
                    match args.get(i + 1).cloned() {
                        Some(path) => {
                            eprintln!("[theme-watch] watching {path}");
                            let handle = app.handle().clone();
                            std::thread::spawn(move || {
                                let p = std::path::PathBuf::from(&path);
                                let mut last_css = String::new();
                                loop {
                                    if let Ok(css) = std::fs::read_to_string(&p) {
                                        if css != last_css {
                                            last_css = css.clone();
                                            let _ = handle.emit("theme-watch:css", css);
                                        }
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(300));
                                }
                            });
                        }
                        None => eprintln!("[theme-watch] usage: --theme-watch <path/to/theme.css>"),
                    }
                }
            }

            // ── Analysis cache (SQLite) ───────────────────────────────────
            {
                let cache = analysis_cache::AnalysisCache::init(app.handle())
                    .map_err(|e| format!("analysis cache init failed: {e}"))?;
                app.manage(cache);
            }

            cover_cache::init_cover_cache(app.handle())
                .map_err(|e| format!("cover cache init failed: {e}"))?;

            library_analysis_backfill::init_library_analysis_backfill(app.handle())
                .map_err(|e| format!("library analysis backfill init failed: {e}"))?;

            // ── Library track store (psysonic-library, PR-5a + PR-5b) ─────
            // PR-5a brought up the read-only Tauri surface + LibraryRuntime.
            // PR-5b adds the mutating commands, sync session map, current-job
            // tracker, and the 30-second background scheduler tick task below
            // — which sweeps every bound session through
            // `BackgroundScheduler::tick` while honouring the runtime's
            // `scheduler_cancel` flag.
            {
                let store = psysonic_library::store::LibraryStore::init(app.handle())
                    .map_err(|e| format!("library store init failed: {e}"))?;
                let runtime = psysonic_library::LibraryRuntime::new(std::sync::Arc::new(store));
                app.manage(runtime);

                let app_for_sched = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use std::sync::atomic::Ordering;
                    use std::time::Duration;
                    use tokio::time::MissedTickBehavior;

                    let mut interval = tokio::time::interval(Duration::from_secs(30));
                    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                    loop {
                        interval.tick().await;
                        let Some(state) = app_for_sched
                            .try_state::<psysonic_library::LibraryRuntime>()
                        else {
                            break;
                        };
                        if state.scheduler_cancel.load(Ordering::SeqCst) {
                            break;
                        }
                        let sessions = state.snapshot_sessions();
                        if sessions.is_empty() {
                            continue;
                        }
                        let hint = state.current_playback_hint();
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
                            .unwrap_or(0);
                        for session in sessions {
                            let scope = session.library_scope.clone().unwrap_or_default();
                            let flags_bits = psysonic_library::repos::SyncStateRepository::new(
                                &state.store,
                            )
                            .get_capability_flags(&session.server_id, &scope)
                            .ok()
                            .flatten()
                            .unwrap_or(0);
                            let flags = psysonic_library::sync::capability::CapabilityFlags::new(
                                flags_bits,
                            );
                            let registry = app_for_sched.state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>();
                            let subsonic = psysonic_integration::subsonic::subsonic_client_with_registry(
                                Some(registry.as_ref()),
                                &session.server_id,
                                session.base_url.clone(),
                                session.username.clone(),
                                session.password.clone(),
                            );
                            let mut sched =
                                psysonic_library::sync::scheduler::BackgroundScheduler::new(
                                    &state.store,
                                    &subsonic,
                                    session.server_id.clone(),
                                    scope.clone(),
                                    flags,
                                )
                                .with_playback_hint(hint)
                                .with_http_registry(Some(Arc::clone(&registry)));
                            if let Some(tok) = session.navidrome_token.clone() {
                                sched = sched.with_navidrome_credentials(
                                    psysonic_library::sync::capability::NavidromeProbeCredentials {
                                        server_url: session.base_url.clone(),
                                        bearer_token: tok,
                                    },
                                );
                            }
                            let foreground_job = state
                                .current_job()
                                .is_some_and(|j| j.server_id == session.server_id);
                            if foreground_job {
                                sched = sched.with_foreground_sync_job_active(true);
                            }
                            let _ = sched.tick(now_ms).await;
                            // Background ticks stay silent in PR-5b — Tauri
                            // emit for the scheduler path lands when the
                            // Settings panel needs it (PR-5c). Manual
                            // `library_sync_start` already emits via its
                            // own orchestrator.
                        }
                    }
                });
            }

            audio::cleanup_orphan_stream_spill_dir(app.handle());

            // ── Playback-query port (analysis → audio back-edge) ──────────
            // Two closures, each capturing an AppHandle, so analysis_runtime
            // can ask AudioEngine playback questions without depending on the
            // audio crate.
            {
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
                            .is_some_and(|e| crate::audio::ranged_loudness_backfill_should_defer(&e, track_id))
                    },
                );
                app.manage(handle);
            }

            app.manage(psysonic_analysis::analysis_runtime::PlaybackPriorityHints::default());

            // ── Content-hash sink (analysis → library E2 back-edge) ───────
            // After a seed the analysis pipeline records the playback-derived
            // md5_16kb as `track.content_hash` so id-remap can rebind a track
            // when the server reassigns ids. Decoupled from psysonic-library
            // via a psysonic-core port; a no-op when the library has no row for
            // the (server_id, track_id) — i.e. the index is off for that server.
            {
                let app_for_hash = app.handle().clone();
                let sink = psysonic_core::ports::ContentHashSink::new(
                    move |server_id: &str, track_id: &str, md5: &str| {
                        if let Some(runtime) =
                            app_for_hash.try_state::<psysonic_library::LibraryRuntime>()
                        {
                            let _ = psysonic_library::commands::patch_content_hash(
                                &runtime, server_id, track_id, md5,
                            );
                        }
                    },
                );
                app.manage(sink);
            }

            // ── Analysis-readiness query (library → analysis E3 back-edge) ──
            // `library_get_track` enrichment asks whether waveform/loudness are
            // cached for (server_id, track_id, content_hash). Read-only probe:
            // exact key then legacy '' fallback, no re-tag. Decoupled from
            // psysonic-analysis via a psysonic-core port.
            {
                let app_for_readiness = app.handle().clone();
                let query = psysonic_core::ports::AnalysisReadinessQuery::new(
                    move |server_id: &str, track_id: &str, md5: &str| {
                        let Some(cache) = app_for_readiness
                            .try_state::<analysis_cache::AnalysisCache>()
                        else {
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
                        // Legacy '' fallback for rows analysed before E1 wiring.
                        let wf = wf || (!server_id.is_empty() && probe("").0);
                        let ld = ld || (!server_id.is_empty() && probe("").1);
                        (wf, ld)
                    },
                );
                app.manage(query);
            }

            // ── Analysis needs-work probe (library → analysis batch scan) ──
            {
                use psysonic_core::ports::TrackAnalysisNeedsWorkQuery;
                let app_for_needs_work = app.handle().clone();
                let needs_work = TrackAnalysisNeedsWorkQuery::new(
                    move |server_id: &str, track_id: &str| {
                        psysonic_analysis::analysis_runtime::track_analysis_needs_work(
                            &app_for_needs_work,
                            server_id,
                            track_id,
                        )
                    },
                );
                app.manage(needs_work);
            }

            // ── Track enrichment port (analysis → library facts) ───────────
            {
                use psysonic_core::track_enrichment::{TrackEnrichmentPlan, TrackEnrichmentPort};
                use std::time::{SystemTime, UNIX_EPOCH};

                fn enrichment_now_unix_ms() -> i64 {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0)
                }

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

            // Periodic analysis queue sizes (debug logging mode only).
            tauri::async_runtime::spawn(psysonic_analysis::analysis_runtime::analysis_queue_snapshot_loop());

            // ── Custom title bar on Linux ─────────────────────────────────
            // Remove OS window decorations on all Linux so the React TitleBar
            // can take over.  The frontend checks is_tiling_wm() to decide
            // whether to actually render the TitleBar (hidden on tiling WMs).
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                sync_wayland_text_profile_cache_from_disk(&handle);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
                    let _ = linux_webkit_apply_wayland_gpu_font_tuning(&win);
                    let _ = linux_webkit_reapply_cached_wayland_text_render_profile(&win);
                    // Suppress WebKit's own MPRIS player so radio (HTML <audio>)
                    // doesn't duplicate the souvlaki one (issue #1048).
                    let _ = linux_webkit_disable_media_session(&win);
                }
            }

            // ── System tray ───────────────────────────────────────────────
            // Always build on startup when possible; the frontend calls toggle_tray_icon(false)
            // immediately after load if the user has disabled the tray icon.
            // May be skipped if Ayatana/AppIndicator libraries are missing (no panic).
            {
                if let Some(tray) = try_build_tray_icon(app.handle()) {
                    *app.state::<TrayState>().lock().unwrap() = Some(tray);
                }
            }

            // ── MPRIS2 / OS media controls via souvlaki ──────────────────
            // Release only: debug builds share the D-Bus name / SMTC slot with prod.
            #[cfg(not(debug_assertions))]
            {
                use souvlaki::{MediaControlEvent, MediaControls, PlatformConfig};

                // Collect pre-conditions and the platform-specific HWND.
                // Returns None early (with a log) on any unrecoverable condition
                // so app.manage() always executes exactly once at the bottom.
                let maybe_controls: Option<MediaControls> = (|| {
                    // Linux: requires a live D-Bus session.
                    #[cfg(target_os = "linux")]
                    {
                        let dbus_ok = std::env::var("DBUS_SESSION_BUS_ADDRESS")
                            .map(|v| !v.is_empty())
                            .unwrap_or(false);
                        if !dbus_ok {
                            crate::app_eprintln!("[Psysonic] No D-Bus session — MPRIS media controls disabled");
                            return None;
                        }
                    }

                    // Windows: souvlaki SMTC must hook into the existing Win32
                    // message loop rather than spinning up its own. Pass the
                    // main window's HWND so it can do so. If we can't get one,
                    // skip init (no crash, just no media overlay).
                    #[cfg(target_os = "windows")]
                    let hwnd = {
                        use tauri::Manager;
                        let h = app.get_webview_window("main")
                            .and_then(|w| w.hwnd().ok())
                            .map(|h| h.0);
                        if h.is_none() {
                            crate::app_eprintln!("[Psysonic] Could not get HWND — Windows media controls disabled");
                            return None;
                        }
                        h
                    };
                    #[cfg(not(target_os = "windows"))]
                    let hwnd: Option<*mut std::ffi::c_void> = None;

                    let config = PlatformConfig {
                        dbus_name: "psysonic",
                        display_name: "Psysonic",
                        hwnd,
                    };

                    match MediaControls::new(config) {
                        Ok(mut controls) => {
                            let app_handle = app.handle().clone();
                            if let Err(e) = controls.attach(move |event: MediaControlEvent| {
                                match event {
                                    // Keep Play/Pause distinct from Toggle: the OS
                                    // (notably macOS on audio-route changes, e.g. a
                                    // headphone disconnect) sends an explicit Pause,
                                    // and collapsing all three into a toggle would
                                    // resume paused playback on the new device (#1094).
                                    MediaControlEvent::Toggle => {
                                        let _ = app_handle.emit("media:play-pause", ());
                                    }
                                    MediaControlEvent::Play => {
                                        let _ = app_handle.emit("media:play", ());
                                    }
                                    MediaControlEvent::Pause => {
                                        let _ = app_handle.emit("media:pause", ());
                                    }
                                    MediaControlEvent::Next => {
                                        let _ = app_handle.emit("media:next", ());
                                    }
                                    MediaControlEvent::Previous => {
                                        let _ = app_handle.emit("media:prev", ());
                                    }
                                    MediaControlEvent::Seek(direction) => {
                                        use souvlaki::SeekDirection;
                                        let delta: f64 = match direction {
                                            SeekDirection::Forward  =>  5.0,
                                            SeekDirection::Backward => -5.0,
                                        };
                                        let _ = app_handle.emit("media:seek-relative", delta);
                                    }
                                    MediaControlEvent::SetPosition(pos) => {
                                        let secs = pos.0.as_secs_f64();
                                        let _ = app_handle.emit("media:seek-absolute", secs);
                                    }
                                    _ => {}
                                }
                            }) {
                                crate::app_eprintln!("[Psysonic] Failed to attach media controls: {e:?}");
                            }
                            Some(controls)
                        }
                        Err(e) => {
                            crate::app_eprintln!("[Psysonic] Could not create media controls: {e:?}");
                            None
                        }
                    }
                })();

                app.manage(MprisControls::new(maybe_controls));
            }
            #[cfg(debug_assertions)]
            {
                app.manage(MprisControls::new(None));
            }

            // ── Windows Taskbar Thumbnail Toolbar ────────────────────────
            #[cfg(all(target_os = "windows", not(debug_assertions)))]
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(hwnd) = w.hwnd() {
                        taskbar_win::init(app.handle(), hwnd.0 as isize);
                    }
                }
            }

            // ── Audio device-change watcher ───────────────────────────────
            {
                use tauri::Manager;
                let engine = app.state::<audio::AudioEngine>();
                audio::start_device_watcher(&engine, app.handle().clone());
                audio::start_stream_idle_watcher(app.handle().clone());
            }

            // ── Reopen output after system sleep/resume (WASAPI / PipeWire etc.)
            audio::register_post_sleep_audio_recovery(app.handle().clone());

            // ── Pre-create mini player window (Windows) ──────────────────
            // Creating the second WebView2 webview lazily from an invoke
            // handler on Windows reliably stalls the Tauri event loop —
            // the mini shows a blank white window, neither main nor mini
            // can be closed, and the user has to kill the process via
            // Task Manager. Building it at startup (hidden) avoids the
            // runtime-creation code path entirely; later `open_mini_player`
            // calls are pure show/hide.
            #[cfg(target_os = "windows")]
            {
                if let Err(e) = build_mini_player_window(app.handle(), false) {
                    crate::app_eprintln!("[psysonic] Failed to pre-create mini window: {e}");
                }
            }

            // Cold start with `--player …`: defer emit so the webview can register listeners.
            crate::cli::spawn_deferred_cli_argv_handler(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Persist mini player position whenever the user drags it.
            if window.label() == "mini" {
                if let tauri::WindowEvent::Moved(pos) = event {
                    persist_mini_pos_throttled(window.app_handle(), pos.x, pos.y);
                }
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    // All platforms: pause rendering, then let JS decide hide-to-tray
                    // vs exit based on the minimizeToTray setting. macOS previously
                    // always force-quit on the red close button, ignoring the setting
                    // (#1103). The tray "Exit" item still emits app:force-quit for an
                    // unconditional quit.
                    if let Some(w) = window.app_handle().get_webview_window("main") {
                        let _ = w.eval(PAUSE_RENDERING_JS);
                    }
                    let _ = window.emit("window:close-requested", ());
                } else if window.label() == "mini" {
                    // Native close on the mini: hide instead of destroying so
                    // state is preserved, and restore the main window.
                    api.prevent_close();
                    if let Some(w) = window.app_handle().get_webview_window("mini") {
                        let _ = w.eval(PAUSE_RENDERING_JS);
                    }
                    let _ = window.hide();
                    if let Some(main) = window.app_handle().get_webview_window("main") {
                        let _ = crate::lib_commands::ui::mini::restore_main_window(&main);
                    }
                }
            }
        })
        .on_page_load(|webview, payload| {
            if webview.label() != "main" {
                return;
            }

            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    let app = webview.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(48));
                        if let Some(window) = app.get_webview_window("main") {
                            crate::lib_commands::ui::mini::eval_startup_main_window_visibility(&window);
                        }
                    });
                }
                tauri::webview::PageLoadEvent::Finished => {
                    if let Some(window) = webview.app_handle().get_webview_window("main") {
                        crate::lib_commands::ui::mini::eval_startup_main_window_visibility(&window);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            theme_import::import_theme_zip,
            backup_export_library_db,
            backup_import_library_db,
            backup_export_full,
            backup_import_full,
            migration_inspect,
            migration_run,
            resolve_host_addresses,
            probe_server_connection,
            subsonic_proxy_request,
            server_http_context_sync,
            server_http_context_sync_all,
            server_http_context_clear,
            psysonic_syncfs::sync::batch::calculate_sync_payload,
            exit_app,
            cli_publish_player_snapshot,
            cli_publish_library_list,
            cli_publish_server_list,
            cli_publish_search_results,
            set_window_decorations,
            set_linux_webkit_smooth_scrolling,
            linux_wayland_gpu_font_tuning_active,
            linux_wayland_text_render_settings_available,
            set_linux_wayland_text_render_profile,
            set_logging_mode,
            set_psylab_albums_browse_trace,
            set_psylab_artists_browse_trace,
            get_logging_mode,
            tail_runtime_logs,
            export_runtime_logs,
            frontend_debug_log,
            performance_cpu_snapshot,
            set_subsonic_wire_user_agent,
            no_compositing_mode,
            theme_animation_risk,
            linux_xdg_session_type,
            is_tiling_wm_cmd,
            open_mini_player,
            preload_mini_player,
            close_mini_player,
            set_mini_player_always_on_top,
            resize_mini_player,
            show_main_window,
            pause_rendering,
            resume_rendering,
            register_global_shortcut,
            unregister_global_shortcut,
            mpris_set_metadata,
            mpris_set_playback,
            audio::commands::audio_play,
            audio::transport_commands::audio_pause,
            audio::transport_commands::audio_resume,
            audio::transport_commands::audio_stop,
            audio::transport_commands::audio_seek,
            audio::mix_commands::audio_set_volume,
            audio::mix_commands::audio_update_replay_gain,
            audio::mix_commands::audio_set_eq,
            audio::mix_commands::audio_set_playback_rate,
            audio::autoeq_commands::autoeq_entries,
            audio::autoeq_commands::autoeq_fetch_profile,
            audio::preload_commands::audio_preload,
            audio::radio_commands::audio_play_radio,
            audio::preview::audio_preview_play,
            audio::preview::audio_preview_stop,
            audio::preview::audio_preview_stop_silent,
            audio::preview::audio_preview_set_volume,
            audio::mix_commands::audio_set_crossfade,
            audio::mix_commands::audio_set_gapless,
            audio::mix_commands::audio_begin_outgoing_fade,
            audio::mix_commands::audio_set_autodj_suppress,
            audio::mix_commands::audio_set_normalization,
            audio::device_commands::audio_list_devices,
            audio::device_commands::audio_canonicalize_selected_device,
            audio::device_commands::audio_default_output_device_name,
            audio::device_commands::audio_set_device,
            audio::commands::audio_chain_preload,
            psysonic_integration::discord::discord_update_presence,
            psysonic_integration::discord::discord_clear_presence,
            psysonic_integration::remote::audioscrobbler_request,
            psysonic_integration::remote::listenbrainz_request,
            psysonic_integration::remote::maloja_request,
            psysonic_integration::navidrome::covers::upload_playlist_cover,
            psysonic_integration::navidrome::covers::upload_radio_cover,
            psysonic_integration::navidrome::covers::upload_artist_image,
            psysonic_integration::navidrome::covers::delete_radio_cover,
            psysonic_integration::navidrome::users::navidrome_login,
            psysonic_integration::navidrome::users::nd_list_users,
            psysonic_integration::navidrome::users::nd_create_user,
            psysonic_integration::navidrome::users::nd_update_user,
            psysonic_integration::navidrome::users::nd_delete_user,
            psysonic_integration::navidrome::queries::nd_list_libraries,
            psysonic_integration::navidrome::queries::nd_list_songs,
            psysonic_integration::navidrome::queries::nd_list_artists_by_role,
            psysonic_integration::navidrome::queries::nd_list_albums_by_artist_role,
            psysonic_integration::navidrome::queries::nd_set_user_libraries,
            psysonic_integration::navidrome::playlists::nd_list_playlists,
            psysonic_integration::navidrome::playlists::nd_create_playlist,
            psysonic_integration::navidrome::playlists::nd_update_playlist,
            psysonic_integration::navidrome::playlists::nd_get_playlist,
            psysonic_integration::navidrome::playlists::nd_delete_playlist,
            psysonic_integration::navidrome::queries::nd_get_song_path,
            psysonic_integration::remote::search_radio_browser,
            psysonic_integration::remote::get_top_radio_stations,
            psysonic_integration::remote::fetch_url_bytes,
            psysonic_integration::remote::fetch_json_url,
            psysonic_integration::remote::fetch_icy_metadata,
            psysonic_integration::remote::resolve_stream_url,
            psysonic_analysis::commands::analysis_get_waveform,
            psysonic_analysis::commands::analysis_get_waveform_for_track,
            psysonic_analysis::commands::analysis_get_loudness_for_track,
            psysonic_analysis::commands::analysis_delete_loudness_for_track,
            psysonic_analysis::commands::analysis_delete_waveform_for_track,
            psysonic_analysis::commands::analysis_delete_all_waveforms,
            psysonic_analysis::commands::analysis_delete_all_for_server,
            psysonic_analysis::commands::analysis_get_failed_track_count,
            psysonic_analysis::commands::analysis_list_failed_tracks,
            psysonic_analysis::commands::analysis_clear_failed_tracks,
            psysonic_analysis::commands::analysis_migrate_server_index_keys,
            psysonic_analysis::commands::analysis_enqueue_seed_from_url,
            psysonic_analysis::commands::analysis_set_playback_priority_hints,
            psysonic_analysis::commands::analysis_set_pipeline_parallelism,
            psysonic_analysis::commands::analysis_get_pipeline_queue_stats,
            psysonic_analysis::commands::analysis_get_backfill_queue_stats,
            psysonic_analysis::commands::analysis_prune_pending_to_track_ids,
            psysonic_library::commands::library_get_status,
            psysonic_library::commands::library_search,
            psysonic_library::commands::library_live_search,
            psysonic_library::commands::library_advanced_search,
            psysonic_library::commands::library_list_lossless_albums,
            psysonic_library::commands::library_list_albums_by_genre,
            psysonic_library::commands::library_genre_tags_inspect,
            psysonic_library::commands::library_genre_tags_run,
            psysonic_library::commands::library_cluster_rebuild,
            psysonic_library::commands::library_scope_list_albums,
            psysonic_library::commands::library_scope_list_artists,
            psysonic_library::commands::library_scope_search_tracks,
            psysonic_library::commands::library_scope_album_detail,
            psysonic_library::commands::library_scope_artist_detail,
            psysonic_library::commands::library_get_artist_lossless_browse,
            psysonic_library::commands::library_search_cross_server,
            psysonic_library::commands::library_get_track,
            psysonic_library::commands::library_get_tracks_batch,
            psysonic_library::commands::library_get_tracks_by_album,
            psysonic_library::commands::library_upsert_songs_from_api,
            psysonic_library::commands::library_get_artifact,
            psysonic_library::commands::library_get_facts,
            psysonic_library::commands::library_get_offline_path,
            psysonic_library::commands::library_analysis_progress,
            psysonic_library::commands::library_count_live_tracks,
            psysonic_library::commands::library_sync_bind_session,
            psysonic_library::commands::library_sync_clear_session,
            psysonic_library::commands::library_set_playback_hint,
            psysonic_library::commands::library_get_playback_hint,
            psysonic_library::commands::library_sync_start,
            psysonic_library::commands::library_sync_verify_integrity,
            psysonic_library::commands::library_sync_cancel,
            psysonic_library::commands::library_patch_track,
            psysonic_library::browse_support::library_patch_album,
            psysonic_library::browse_support::library_reconcile_album_stars,
            psysonic_library::browse_support::library_get_catalog_year_bounds,
            psysonic_library::browse_support::library_get_genre_album_counts,
            psysonic_library::commands::library_put_artifact,
            psysonic_library::commands::library_put_fact,
            psysonic_library::commands::library_record_play_session,
            psysonic_library::commands::library_get_player_stats_year_summary,
            psysonic_library::commands::library_get_player_stats_heatmap,
            psysonic_library::commands::library_get_player_stats_day_detail,
            psysonic_library::commands::library_get_player_stats_year_bounds,
            psysonic_library::commands::library_get_player_stats_recent_days,
            psysonic_library::commands::library_get_recent_play_sessions,
            psysonic_library::commands::library_purge_server,
            psysonic_library::commands::library_migrate_server_index_keys,
            psysonic_library::commands::library_delete_server_data,
            psysonic_library::commands::library_analysis_backfill_batch,
            library_analysis_backfill::library_analysis_backfill_configure,
            psysonic_library::commands::library_resolve_cover_entry,
            cover_cache::cover_cache_peek_batch,
            cover_cache::cover_cache_ensure,
            cover_cache::cover_cache_ensure_batch,
            cover_cache::cover_cache_stats,
            cover_cache::cover_cache_evict_tick,
            cover_cache::cover_cache_configure,
            cover_cache::cover_cache_clear,
            cover_cache::cover_cache_clear_server,
            cover_cache::cover_cache_purge_external,
            cover_cache::cover_cache_rename_server_bucket,
            cover_cache::cover_cache_stats_server,
            cover_cache::cover_cache_get_pipeline_queue_stats,
            cover_cache::library_cover_backfill_batch,
            cover_cache::library_cover_progress,
            cover_cache::library_cover_catalog_size,
            cover_cache::library_cover_clear_fetch_failures,
            cover_cache::library_cover_backfill_configure,
            cover_cache::library_cover_backfill_set_base_url,
            cover_cache::library_cover_backfill_pulse,
            cover_cache::library_cover_backfill_reset_cursor,
            cover_cache::library_cover_backfill_set_ui_priority,
            cover_cache::library_cover_backfill_set_parallel,
            cover_cache::library_cover_backfill_run_full_pass,
            cover_cache::cover_revalidate_enqueue,
            cover_cache::cover_revalidate_tick,
            cover_cache::cover_revalidate_batch,
            psysonic_syncfs::cache::offline::download_track_offline,
            psysonic_syncfs::cache::offline::cancel_offline_downloads,
            psysonic_syncfs::cache::offline::clear_offline_cancel,
            psysonic_syncfs::cache::offline::delete_offline_track,
            psysonic_syncfs::cache::offline::get_offline_cache_size,
            psysonic_syncfs::cache::local::download_track_local,
            psysonic_syncfs::cache::local::probe_library_track_local,
            psysonic_syncfs::cache::local::discover_library_tier_on_disk,
            psysonic_syncfs::cache::local::prune_orphan_library_tier_files,
            psysonic_syncfs::cache::local::prune_orphan_ephemeral_cache_files,
            psysonic_syncfs::cache::local::evict_ephemeral_cache_orphans_to_fit,
            psysonic_syncfs::cache::local::probe_media_files,
            psysonic_syncfs::cache::local::get_media_tier_size,
            psysonic_syncfs::cache::local::purge_media_tier,
            psysonic_syncfs::cache::local::delete_media_file,
            psysonic_syncfs::cache::local::prune_empty_media_tier_dirs,
            psysonic_syncfs::cache::local::promote_stream_cache_to_local,
            psysonic_syncfs::cache::local::migrate_legacy_offline_disk,
            psysonic_syncfs::cache::hot::download_track_hot_cache,
            psysonic_syncfs::cache::hot::promote_stream_cache_to_hot_cache,
            psysonic_syncfs::cache::hot::get_hot_cache_size,
            psysonic_syncfs::cache::hot::delete_hot_cache_track,
            psysonic_syncfs::cache::hot::purge_hot_cache,
            psysonic_syncfs::sync::device::sync_track_to_device,
            psysonic_syncfs::sync::batch::sync_batch_to_device,
            psysonic_syncfs::sync::batch::cancel_device_sync,
            psysonic_syncfs::sync::device::compute_sync_paths,
            psysonic_syncfs::sync::batch::list_device_dir_files,
            psysonic_syncfs::sync::batch::delete_device_file,
            psysonic_syncfs::sync::batch::delete_device_files,
            psysonic_syncfs::sync::device::get_removable_drives,
            psysonic_syncfs::sync::device::write_device_manifest,
            psysonic_syncfs::sync::device::read_device_manifest,
            psysonic_syncfs::sync::device::write_playlist_m3u8,
            psysonic_syncfs::sync::device::rename_device_files,
            toggle_tray_icon,
            set_tray_tooltip,
            set_tray_menu_labels,
            check_dir_accessible,
            psysonic_syncfs::cache::downloads::download_zip,
            psysonic_syncfs::cache::downloads::check_arch_linux,
            psysonic_syncfs::cache::downloads::download_update,
            psysonic_syncfs::cache::downloads::open_folder,
            psysonic_syncfs::cache::downloads::get_embedded_lyrics,
            psysonic_syncfs::cache::downloads::fetch_netease_lyrics,
            // cover_cache (cover_revalidate_batch excluded: returns serde_json::Value)
            cover_cache::cover_cache_peek_batch,
            cover_cache::cover_cache_ensure,
            cover_cache::cover_cache_ensure_batch,
            cover_cache::cover_cache_stats,
            cover_cache::cover_cache_evict_tick,
            cover_cache::cover_cache_configure,
            cover_cache::cover_cache_clear,
            cover_cache::cover_cache_clear_server,
            cover_cache::cover_cache_purge_external,
            cover_cache::cover_cache_rename_server_bucket,
            cover_cache::cover_cache_stats_server,
            cover_cache::cover_cache_get_pipeline_queue_stats,
            cover_cache::library_cover_backfill_batch,
            cover_cache::library_cover_progress,
            cover_cache::library_cover_catalog_size,
            cover_cache::library_cover_clear_fetch_failures,
            cover_cache::library_cover_backfill_configure,
            cover_cache::library_cover_backfill_set_base_url,
            cover_cache::library_cover_backfill_pulse,
            cover_cache::library_cover_backfill_reset_cursor,
            cover_cache::library_cover_backfill_set_ui_priority,
            cover_cache::library_cover_backfill_set_parallel,
            cover_cache::library_cover_backfill_run_full_pass,
            cover_cache::cover_revalidate_enqueue,
            cover_cache::cover_revalidate_tick,
            psysonic_integration::bandsintown::fetch_bandsintown_events,
            #[cfg(target_os = "windows")]
            taskbar_win::update_taskbar_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Psysonic");
}

#[cfg(test)]
mod specta_export {
    // Freshness gate. Exports to a throwaway temp path and asserts byte-equality
    // with the committed `src/generated/bindings.ts`. A Rust command/DTO change
    // that isn't regenerated diverges here → `cargo test` fails → CI catches the
    // stale bindings. Crucially the test exports to a temp file, never the tracked
    // one, so it neither dirties the working tree nor races other export tests.
    // Regenerate the committed file headlessly with the `#[ignore]`d
    // `regenerate_committed_bindings` below (or a `npm run tauri:dev` debug
    // launch, which runs `export_specta_bindings()`), then commit the result.
    #[test]
    fn committed_bindings_are_fresh() {
        let committed_path = "../src/generated/bindings.ts";
        let tmp = std::env::temp_dir().join(format!(
            "psysonic-bindings-freshness-{}.ts",
            std::process::id()
        ));

        super::specta_builder()
            .export(super::bindings_exporter(), &tmp)
            .expect("failed to export typescript bindings");

        let generated = std::fs::read_to_string(&tmp).expect("read freshly exported bindings");
        let _ = std::fs::remove_file(&tmp);
        let committed =
            std::fs::read_to_string(committed_path).expect("read committed bindings.ts");

        assert_eq!(
            committed, generated,
            "src/generated/bindings.ts is stale — regenerate it with \
             `cargo test -p psysonic regenerate_committed_bindings -- --ignored` \
             and commit the result"
        );
    }

    // Headless regeneration of the committed bindings. `#[ignore]`d so it never
    // runs in CI / default `cargo test` (which keeps the tracked file untouched
    // and lets `committed_bindings_are_fresh` be the gate); run it explicitly to
    // rewrite the file after annotating commands:
    //   cargo test -p psysonic regenerate_committed_bindings -- --ignored
    #[test]
    #[ignore = "writes the tracked src/generated/bindings.ts; run explicitly to regenerate"]
    fn regenerate_committed_bindings() {
        // Export to a sibling temp file then atomically rename over the tracked
        // one, so a concurrent reader (e.g. `committed_bindings_are_fresh` under
        // `--include-ignored`) never observes a half-written/truncated file.
        let target = "../src/generated/bindings.ts";
        let tmp = "../src/generated/bindings.ts.regen.tmp";
        super::specta_builder()
            .export(super::bindings_exporter(), tmp)
            .expect("failed to export typescript bindings");
        std::fs::rename(tmp, target).expect("failed to move regenerated bindings into place");
    }

    // ── G-sync anti-drift guard (Option A) ──────────────────────────────────
    // Every command registered in the live `generate_handler!` must EITHER be
    // collected into `collect_commands!` (so the FE gets a typed binding) OR
    // appear in `UNTYPEABLE` below with the reason it can't be typed under the
    // pinned specta =2.0.0-rc.25. This fails if a new command lands in the
    // handler without doing one or the other — so the typed IPC surface can't
    // silently rot as commands are added. The allowlist is exact and can only
    // shrink: making a command typeable (a `Value` return replaced by a DTO, an
    // arg count dropping to ≤10) means collecting it AND removing it here.
    //
    // Under Option A `generate_handler!` stays the permanent live handler; this
    // test — not a handler flip — is what keeps the two lists in sync.
    #[test]
    fn typeable_commands_are_all_collected() {
        // Known-untypeable under specta =2.0.0-rc.25 (see the specta-contract
        // plan). Three reasons only:
        const UNTYPEABLE: &[&str] = &[
            // (1) serde_json::Value / raw-JSON passthrough in the signature —
            // rc.25 registers `Value` as inline-self-recursive and overflows the
            // exporter. `raw_json`-carrying library DTO envelopes count too.
            "audioscrobbler_request",
            "listenbrainz_request",
            "maloja_request",
            "backup_export_full",
            "backup_import_full",
            "cli_publish_library_list",
            "cli_publish_player_snapshot",
            "cli_publish_search_results",
            "cli_publish_server_list",
            "calculate_sync_payload",
            "read_device_manifest",
            "write_device_manifest",
            "cover_revalidate_batch",
            "fetch_json_url",
            "get_top_radio_stations",
            "search_radio_browser",
            "library_advanced_search",
            "library_get_artist_lossless_browse",
            "library_get_track",
            "library_get_tracks_batch",
            "library_get_tracks_by_album",
            "library_list_albums_by_genre",
            "library_list_lossless_albums",
            "library_live_search",
            "library_scope_album_detail",
            "library_scope_artist_detail",
            "library_scope_list_albums",
            "library_scope_list_artists",
            "library_scope_search_tracks",
            "library_search",
            "library_search_cross_server",
            "library_patch_track",
            "library_patch_album",
            "library_upsert_songs_from_api",
            "nd_create_playlist",
            "nd_get_playlist",
            "nd_list_playlists",
            "nd_update_playlist",
            "nd_create_user",
            "nd_list_users",
            "nd_update_user",
            "nd_list_albums_by_artist_role",
            "nd_list_artists_by_role",
            "nd_list_libraries",
            "nd_list_songs",
            // (2) >10 total params (State/AppHandle/Window included) exceed
            // specta's SpectaFn arg cap. Typing needs the args bundled into a
            // struct = an IPC arg-shape change, out of scope for Option A.
            "audio_play",
            "audio_chain_preload",
            "discord_update_presence",
            "download_track_local",
            // (3) platform-gated — `#[cfg(target_os = "windows")]`, so absent
            // from the Linux specta export the committed bindings are built from.
            "update_taskbar_icon",
        ];

        let src = include_str!("lib.rs");
        let handler = command_names(src, "generate_handler!");
        let collected = command_names(src, "collect_commands!");
        assert!(
            handler.len() > 200 && collected.len() > 150,
            "command-list parser found too few entries (handler={}, collected={}) \
             — the macro formatting probably changed; fix `command_names`",
            handler.len(),
            collected.len()
        );

        let mut uncollected: Vec<&str> =
            handler.iter().filter(|c| !collected.contains(*c)).map(String::as_str).collect();
        uncollected.sort_unstable();

        let unexplained: Vec<&str> =
            uncollected.iter().copied().filter(|c| !UNTYPEABLE.contains(c)).collect();
        assert!(
            unexplained.is_empty(),
            "these commands are in generate_handler! but neither collected into \
             collect_commands! nor listed in UNTYPEABLE — annotate them with \
             #[specta::specta] + add to collect_commands!, or add them to \
             UNTYPEABLE with the reason: {unexplained:?}"
        );

        let stale: Vec<&str> =
            UNTYPEABLE.iter().copied().filter(|c| !uncollected.contains(c)).collect();
        assert!(
            stale.is_empty(),
            "these commands are in the UNTYPEABLE allowlist but are no longer \
             uncollected (they got collected, or left generate_handler!) — remove \
             them from UNTYPEABLE: {stale:?}"
        );
    }

    /// Extract the last `::`-segment identifier of every entry inside a
    /// `<macro>![ ... ]` invocation. Mirrors the Python worklist parser: one
    /// command per line, skips `//` comments and `#[..]` attribute lines. Picks
    /// the real invocation (a `[` follows the macro name), not a doc-comment
    /// mention of the macro.
    fn command_names(src: &str, macro_call: &str) -> std::collections::HashSet<String> {
        let mut out = std::collections::HashSet::new();
        let open = src.match_indices(macro_call).find_map(|(idx, _)| {
            let rest = &src[idx + macro_call.len()..];
            let trimmed = rest.trim_start();
            trimmed
                .starts_with('[')
                .then(|| idx + macro_call.len() + (rest.len() - trimmed.len()))
        });
        let Some(open) = open else {
            return out;
        };

        let bytes = src.as_bytes();
        let (mut i, mut depth, mut close) = (open, 0i32, open);
        while i < bytes.len() {
            match bytes[i] {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        close = i;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }

        for raw in src[open + 1..close].lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
                continue;
            }
            let code = line.split("//").next().unwrap_or("").trim().trim_end_matches(',');
            let seg = code.rsplit("::").next().unwrap_or("").trim();
            let ok = seg.starts_with(|c: char| c.is_ascii_lowercase())
                && seg.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            if ok {
                out.insert(seg.to_string());
            }
        }
        out
    }

    // ── Reverse anti-drift guard ────────────────────────────────────────────
    // The forward guard above catches a command that lands in `generate_handler!`
    // without being collected. It cannot see a command that leaves the handler
    // ENTIRELY — exactly how `download_track_local` silently became unregistered
    // (offline caching went dead) when the specta annotation pass dropped it from
    // `generate_handler!` and its >10-arg signature kept it out of
    // `collect_commands!` too, so it fell through both lists. This test scans every
    // `#[tauri::command]` fn in the workspace sources and asserts each is wired into
    // `generate_handler!`, so a command can never fall out of the live IPC surface
    // unnoticed.
    #[test]
    fn every_command_is_registered_in_the_handler() {
        // Commands intentionally NOT in `generate_handler!` (invoked in-process,
        // never over IPC). Empty by default — add one only with the reason it is
        // internal-only; the stale-check below drops any entry that got registered.
        const HANDLER_EXEMPT: &[&str] = &[];

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut command_fns = Vec::new();
        for root in ["src", "crates"] {
            collect_command_fns(&manifest.join(root), &mut command_fns);
        }
        assert!(
            command_fns.len() > 200,
            "command-fn scanner found too few #[tauri::command] fns ({}) — the \
             attribute/fn layout probably changed; fix `collect_command_fns`",
            command_fns.len()
        );

        // This guard compares handler↔command by BARE fn name, so two commands
        // sharing a bare name across crates would be indistinguishable — one could
        // drop out of the handler while its namesake keeps the check green. Fail
        // loudly if that ever happens rather than silently trusting the name.
        let mut counts = std::collections::HashMap::new();
        for name in &command_fns {
            *counts.entry(name.as_str()).or_insert(0) += 1;
        }
        let mut collisions: Vec<&str> =
            counts.iter().filter(|(_, n)| **n > 1).map(|(name, _)| *name).collect();
        collisions.sort_unstable();
        assert!(
            collisions.is_empty(),
            "two #[tauri::command] fns share a bare name {collisions:?} — this guard \
             can't tell them apart; disambiguate before the name-based check is trusted"
        );

        let handler = command_names(include_str!("lib.rs"), "generate_handler!");
        let mut missing: Vec<&str> = command_fns
            .iter()
            .map(String::as_str)
            .filter(|c| !handler.contains(*c) && !HANDLER_EXEMPT.contains(c))
            .collect();
        missing.sort_unstable();
        missing.dedup();
        assert!(
            missing.is_empty(),
            "these #[tauri::command] fns are defined but NOT registered in \
             generate_handler! — they are dead over IPC (add them to the handler, \
             or to HANDLER_EXEMPT if intentionally internal-only): {missing:?}"
        );

        let stale: Vec<&str> = HANDLER_EXEMPT
            .iter()
            .copied()
            .filter(|c| command_fns.iter().any(|f| f == c) && handler.contains(*c))
            .collect();
        assert!(
            stale.is_empty(),
            "these commands are in HANDLER_EXEMPT but are actually registered in \
             generate_handler! — remove them from HANDLER_EXEMPT: {stale:?}"
        );
    }

    /// Recursively collect the name of every `#[tauri::command]` fn under `dir`.
    /// Matches only a real attribute line (`#[tauri::command...`), never a
    /// doc-comment *mention* of the macro (those start with `///`), then reads the
    /// fn name from the next `fn` declaration, skipping intervening `#[..]`
    /// attribute lines.
    fn collect_command_fns(dir: &std::path::Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().and_then(|n| n.to_str()) == Some("target") {
                    continue;
                }
                collect_command_fns(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                let Ok(src) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let lines: Vec<&str> = src.lines().collect();
                for (i, raw) in lines.iter().enumerate() {
                    if !raw.trim_start().starts_with("#[tauri::command") {
                        continue;
                    }
                    for line in &lines[i + 1..] {
                        let t = line.trim_start();
                        if t.starts_with("#[") || t.starts_with("//") || t.is_empty() {
                            continue;
                        }
                        if let Some(name) = fn_name(t) {
                            out.push(name);
                            break;
                        }
                        // A non-attribute, non-comment, non-blank line that is not a
                        // fn decl is an attribute *continuation* (a multi-line
                        // `#[tauri::command(\n  rename_all = ...\n)]`) — keep scanning
                        // to the fn instead of giving up and dropping the command.
                    }
                }
            }
        }
    }

    /// Extract `name` from a `... fn name(...)` declaration line.
    fn fn_name(line: &str) -> Option<String> {
        let after = line.split(" fn ").nth(1).or_else(|| line.strip_prefix("fn "))?;
        let name: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        (!name.is_empty()).then_some(name)
    }
}
