// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod cli;
mod lib_commands;

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

pub fn run() {
    // Linux: second `psysonic --player …` forwards over D-Bus before heavy startup.
    #[cfg(target_os = "linux")]
    {
        let argv: Vec<String> = std::env::args().collect();
        if crate::cli::parse_cli_command(&argv).is_some() {
            match crate::cli::linux_try_forward_player_cli_secondary(&argv) {
                Ok(crate::cli::LinuxPlayerForwardResult::Forwarded) => std::process::exit(0),
                Ok(crate::cli::LinuxPlayerForwardResult::ContinueStartup) => {}
                Err(msg) => {
                    crate::app_eprintln!("NOT OK: {msg}");
                    std::process::exit(1);
                }
            }
        }
    }

    let (audio_engine, _audio_thread) = audio::create_engine();

    tauri::Builder::default()
        .manage(audio_engine)
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
                .with_denylist(&["mini"])
                .build()
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
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
        }))

        .setup(|app| {
            // ── Analysis cache (SQLite) ───────────────────────────────────
            {
                let cache = analysis_cache::AnalysisCache::init(app.handle())
                    .map_err(|e| format!("analysis cache init failed: {e}"))?;
                app.manage(cache);
            }

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

            // Periodic analysis queue sizes (debug logging mode only).
            tauri::async_runtime::spawn(psysonic_analysis::analysis_runtime::analysis_queue_snapshot_loop());

            // ── Custom title bar on Linux ─────────────────────────────────
            // Remove OS window decorations on all Linux so the React TitleBar
            // can take over.  The frontend checks is_tiling_wm() to decide
            // whether to actually render the TitleBar (hidden on tiling WMs).
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
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
                                    MediaControlEvent::Toggle
                                    | MediaControlEvent::Play
                                    | MediaControlEvent::Pause => {
                                        let _ = app_handle.emit("media:play-pause", ());
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

            // ── Windows Taskbar Thumbnail Toolbar ────────────────────────
            #[cfg(target_os = "windows")]
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

                    #[cfg(target_os = "macos")]
                    {
                        // On macOS the red close button quits the app entirely.
                        // Route through JS so playback position + Orbit state get
                        // flushed; exit_app on the way back stops the audio engine.
                        let _ = window.emit("app:force-quit", ());
                    }

                    #[cfg(not(target_os = "macos"))]
                    {
                        // Pause rendering before JS decides whether to hide to tray or exit.
                        if let Some(w) = window.app_handle().get_webview_window("main") {
                            let _ = w.eval(PAUSE_RENDERING_JS);
                        }
                        // Let JS decide: minimize to tray or exit, based on user setting.
                        let _ = window.emit("window:close-requested", ());
                    }
                } else if window.label() == "mini" {
                    // Native close on the mini: hide instead of destroying so
                    // state is preserved, and restore the main window.
                    api.prevent_close();
                    if let Some(w) = window.app_handle().get_webview_window("mini") {
                        let _ = w.eval(PAUSE_RENDERING_JS);
                    }
                    let _ = window.hide();
                    if let Some(main) = window.app_handle().get_webview_window("main") {
                        let _ = main.unminimize();
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            psysonic_syncfs::sync::batch::calculate_sync_payload,
            exit_app,
            cli_publish_player_snapshot,
            cli_publish_library_list,
            cli_publish_server_list,
            cli_publish_search_results,
            set_window_decorations,
            set_linux_webkit_smooth_scrolling,
            set_logging_mode,
            export_runtime_logs,
            frontend_debug_log,
            performance_cpu_snapshot,
            set_subsonic_wire_user_agent,
            no_compositing_mode,
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
            audio::mix_commands::audio_set_normalization,
            audio::device_commands::audio_list_devices,
            audio::device_commands::audio_canonicalize_selected_device,
            audio::device_commands::audio_default_output_device_name,
            audio::device_commands::audio_set_device,
            audio::commands::audio_chain_preload,
            psysonic_integration::discord::discord_update_presence,
            psysonic_integration::discord::discord_clear_presence,
            psysonic_integration::remote::lastfm_request,
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
            psysonic_analysis::commands::analysis_enqueue_seed_from_url,
            psysonic_analysis::commands::analysis_prune_pending_to_track_ids,
            psysonic_syncfs::cache::offline::download_track_offline,
            psysonic_syncfs::cache::offline::delete_offline_track,
            psysonic_syncfs::cache::offline::get_offline_cache_size,
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
            psysonic_integration::bandsintown::fetch_bandsintown_events,
            #[cfg(target_os = "windows")]
            taskbar_win::update_taskbar_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Psysonic");
}
