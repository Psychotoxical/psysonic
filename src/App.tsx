import { useEffect } from 'react';
import { showToast } from './utils/toast';
import { useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { endOrbitSession, leaveOrbitSession } from './utils/orbit';
import { useOrbitStore } from './store/orbitStore';
import { useAuthStore } from './store/authStore';
import {
  getMusicFolders,
  getSimilarSongs,
  search as subsonicSearch,
} from './api/subsonic';
import i18n from './i18n';
import { switchActiveServer } from './utils/switchActiveServer';
import {
  usePlayerStore,
  getPlaybackProgressSnapshot,
  songToTrack,
  shuffleArray,
  flushPlayQueuePosition,
} from './store/playerStore';
import { useThemeStore } from './store/themeStore';
import { useThemeScheduler } from './hooks/useThemeScheduler';
import { useFontStore } from './store/fontStore';
import { useKeybindingsStore, buildInAppBinding } from './store/keybindingsStore';
import { useGlobalShortcutsStore } from './store/globalShortcutsStore';
import { useZipDownloadStore } from './store/zipDownloadStore';
import { usePreviewStore } from './store/previewStore';
import { DEFAULT_IN_APP_BINDINGS, canRunShortcutActionInMiniWindow, executeCliPlayerCommand, executeRuntimeAction, isGlobalShortcutActionId, isShortcutAction } from './config/shortcutActions';
import { matchInAppShortcutAction } from './shortcuts/runtime';
import { getWindowKind } from './app/windowKind';
import MiniPlayerApp from './app/MiniPlayerApp';
import MainApp from './app/MainApp';

// Media key + tray event handler
export function TauriEventBridge() {
  const navigate = useNavigate();

  // ZIP download progress events from Rust
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id: string; bytes: number; total: number | null }>('download:zip:progress', e => {
      useZipDownloadStore.getState().updateProgress(e.payload.id, e.payload.bytes, e.payload.total);
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Track-preview lifecycle: Rust audio engine emits start/progress/end. The
  // store mirrors them so any tracklist row can render its preview UI.
  useEffect(() => {
    const unlistenFns: Array<() => void> = [];
    listen<string>('audio:preview-start', e => {
      usePreviewStore.getState()._onStart(e.payload);
    }).then(u => unlistenFns.push(u));
    listen<{ id: string; elapsed: number; duration: number }>('audio:preview-progress', e => {
      usePreviewStore.getState()._onProgress(e.payload.id, e.payload.elapsed, e.payload.duration);
    }).then(u => unlistenFns.push(u));
    listen<{ id: string; reason: string }>('audio:preview-end', e => {
      usePreviewStore.getState()._onEnd(e.payload.id);
    }).then(u => unlistenFns.push(u));
    return () => { unlistenFns.forEach(fn => fn()); };
  }, []);

  // Audio output device changed (Bluetooth headphones, USB DAC, etc.)
  // The Rust device-watcher has already reopened the stream on the new device
  // and dropped the old Sink, so we just need to restart playback.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-changed', () => {
      const { currentTrack, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      if (!currentTrack) return;
      if (isPlaying) {
        playTrack(currentTrack);
      } else {
        // Paused: clear warm-pause flag so the next resume uses the cold path
        // (audio_play + seek) which creates a new Sink on the new device.
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Pinned output device was unplugged — Rust already fell back to system default.
  // Clear the stored device so the Settings dropdown resets to "System Default".
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-reset', () => {
      useAuthStore.getState().setAudioOutputDevice(null);
      const { currentTrack, currentTime, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      if (!currentTrack) return;
      if (isPlaying) {
        playTrack(currentTrack);
      } else {
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player audio-device set …` (forwarded on Linux via single-instance).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('cli:audio-device-set', async e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      const deviceName = raw.length > 0 ? raw : null;
      try {
        await invoke('audio_set_device', { deviceName });
        useAuthStore.getState().setAudioOutputDevice(deviceName);
      } catch {
        /* device open failed — do not persist (same as Settings) */
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player mix append|new` from the currently playing track.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('cli:instant-mix', async e => {
      const mode = e.payload === 'append' ? 'append' : 'new';
      const state = usePlayerStore.getState();
      const song = state.currentTrack;
      if (!song) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
        return;
      }
      const serverId = useAuthStore.getState().activeServerId;
      try {
        const similar = await getSimilarSongs(song.id, 50);
        if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, false);
        const base = similar.filter(s => s.id !== song.id).map(s => songToTrack(s));
        if (mode === 'append') {
          const toAdd = shuffleArray(base.map(t => ({ ...t, autoAdded: true as const })));
          if (toAdd.length > 0) usePlayerStore.getState().enqueue(toAdd);
        } else {
          // New queue from seed: collapse to [song] first, then radio tail (not append onto old queue).
          usePlayerStore.getState().reseedQueueForInstantMix(song);
          const shuffled = shuffleArray(
            base.map(t => ({ ...t, radioAdded: true as const })),
          );
          if (shuffled.length > 0) {
            const aid = song.artistId?.trim() || undefined;
            usePlayerStore.getState().enqueueRadio(shuffled, aid);
          }
        }
      } catch (err) {
        console.error('CLI instant mix failed', err);
        if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, true);
        showToast(i18n.t('contextMenu.instantMixFailed'), 5000, 'error');
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player library list` (Rust polls the JSON file) / `library set`.
  useEffect(() => {
    let u1: (() => void) | undefined;
    let u2: (() => void) | undefined;
    listen('cli:library-list', async () => {
      try {
        const folders = await getMusicFolders();
        const auth = useAuthStore.getState();
        const sid = auth.activeServerId;
        const selected = sid ? (auth.musicLibraryFilterByServer[sid] ?? 'all') : 'all';
        await invoke('cli_publish_library_list', {
          payload: {
            folders: folders.map(f => ({ id: f.id, name: f.name })),
            selected,
            active_server_id: sid,
          },
        });
      } catch (e) {
        console.error('CLI library list failed', e);
        await invoke('cli_publish_library_list', {
          payload: { folders: [], selected: 'all', active_server_id: null },
        }).catch(() => {});
      }
    }).then(u => { u1 = u; });
    listen<string>('cli:library-set', e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      if (raw === 'all') useAuthStore.getState().setMusicLibraryFilter('all');
      else if (raw.length > 0) useAuthStore.getState().setMusicLibraryFilter(raw);
    }).then(u => { u2 = u; });
    return () => {
      u1?.();
      u2?.();
    };
  }, []);

  // CLI: servers, search, transport extras, mute, star, rating, play-by-id, reload.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen('cli:server-list', async () => {
      const auth = useAuthStore.getState();
      await invoke('cli_publish_server_list', {
        payload: {
          active_server_id: auth.activeServerId,
          servers: auth.servers.map(s => ({ id: s.id, name: s.name })),
        },
      });
    }).then(u => unsubs.push(u));
    listen<string>('cli:server-set', async e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      const id = raw.trim();
      if (!id) return;
      const server = useAuthStore.getState().servers.find(s => s.id === id);
      if (!server) {
        showToast(i18n.t('contextMenu.cliServerNotFound', { defaultValue: 'Server id not found.' }), 4000, 'error');
        return;
      }
      const ok = await switchActiveServer(server);
      if (!ok) {
        showToast(i18n.t('contextMenu.cliServerSwitchFailed', { defaultValue: 'Could not switch server (ping failed).' }), 5000, 'error');
      }
    }).then(u => unsubs.push(u));
    listen<{ scope: string; query: string }>('cli:search', async e => {
      const { scope, query } = e.payload;
      const base = { scope, query, ready: false };
      try {
        const r = await subsonicSearch(query, { songCount: 50, albumCount: 30, artistCount: 30 });
        const payload =
          scope === 'track'
            ? {
                ...base,
                songs: r.songs.map(s => ({ id: s.id, title: s.title, artist: s.artist })),
                albums: [] as { id: string; name: string; artist: string }[],
                artists: [] as { id: string; name: string }[],
                ready: true,
              }
            : scope === 'album'
              ? {
                  ...base,
                  songs: [] as { id: string; title: string; artist: string }[],
                  albums: r.albums.map(a => ({ id: a.id, name: a.name, artist: a.artist })),
                  artists: [] as { id: string; name: string }[],
                  ready: true,
                }
              : {
                  ...base,
                  songs: [] as { id: string; title: string; artist: string }[],
                  albums: [] as { id: string; name: string; artist: string }[],
                  artists: r.artists.map(a => ({ id: a.id, name: a.name })),
                  ready: true,
                };
        await invoke('cli_publish_search_results', { payload });
      } catch (err) {
        console.error('CLI search failed', err);
        await invoke('cli_publish_search_results', {
          payload: {
            ...base,
            songs: [],
            albums: [],
            artists: [],
            ready: true,
            error: err instanceof Error ? err.message : 'search failed',
          },
        }).catch(() => {});
      }
    }).then(u => unsubs.push(u));
    listen<any>('cli:player-command', async e => {
      await executeCliPlayerCommand({ payload: e.payload ?? {}, navigate });
    }).then(u => unsubs.push(u));
    return () => {
      unsubs.forEach(u => u());
    };
  }, []);

  // Sync tray-icon visibility with the user's stored setting.
  // Runs once on mount (initial sync) and again whenever the setting changes.
  const showTrayIcon = useAuthStore(s => s.showTrayIcon);
  useEffect(() => {
    invoke('toggle_tray_icon', { show: showTrayIcon }).catch(console.error);
  }, [showTrayIcon]);

  // Configurable keybindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      const editable = Boolean(el?.isContentEditable);
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) return;

      const chord = buildInAppBinding(e);
      if (chord) {
        const registered = Object.values(useGlobalShortcutsStore.getState().shortcuts);
        if (registered.includes(chord)) return;
      }

      const { bindings } = useKeybindingsStore.getState();
      const action = matchInAppShortcutAction(e, { ...DEFAULT_IN_APP_BINDINGS, ...bindings });

      if (!action) return;
      e.preventDefault();
      executeRuntimeAction(action, { navigate, previewPolicy: 'stop' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];

    const setup = async () => {
      const handlers: Array<[string, () => void]> = [
        // Hardware media controls should not interrupt active preview playback.
        ['media:play-pause', () => executeRuntimeAction('play-pause', { navigate, previewPolicy: 'ignore' })],
        ['media:play',       () => executeRuntimeAction('play', { navigate, previewPolicy: 'ignore' })],
        ['media:pause',      () => executeRuntimeAction('pause', { navigate, previewPolicy: 'ignore' })],
        ['media:next',       () => executeRuntimeAction('next', { navigate, previewPolicy: 'ignore' })],
        ['media:prev',       () => executeRuntimeAction('prev', { navigate, previewPolicy: 'ignore' })],
        ['media:stop',       () => executeRuntimeAction('stop', { navigate, previewPolicy: 'ignore' })],
        ['media:volume-up',  () => executeRuntimeAction('volume-up', { navigate, previewPolicy: 'ignore' })],
        ['media:volume-down', () => executeRuntimeAction('volume-down', { navigate, previewPolicy: 'ignore' })],
        // Tray clicks are explicit UI intent: stop preview first, then act.
        ['tray:play-pause',  () => executeRuntimeAction('play-pause', { navigate, previewPolicy: 'stop' })],
        ['tray:next',        () => executeRuntimeAction('next', { navigate, previewPolicy: 'stop' })],
        ['tray:previous',    () => executeRuntimeAction('prev', { navigate, previewPolicy: 'stop' })],
      ];
      for (const [event, handler] of handlers) {
        const u = await listen(event, handler);
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      {
        const u = await listen<string>('shortcut:global-action', e => {
          const action = e.payload;
          if (!isGlobalShortcutActionId(action)) return;
          executeRuntimeAction(action, { navigate, previewPolicy: 'ignore' });
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      {
        const u = await listen<{ action: string; source?: string }>('shortcut:run-action', e => {
          const action = e.payload?.action;
          const source = e.payload?.source;
          if (!action || !isShortcutAction(action)) return;
          if (source === 'mini-window' && !canRunShortcutActionInMiniWindow(action)) return;
          const previewPolicy = source === 'cli' ? 'ignore' : 'stop';
          executeRuntimeAction(action, { navigate, previewPolicy });
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }


      // Seek events carry a numeric payload (seconds) — seek() expects 0-1 progress
      {
        const u = await listen<number>('media:seek-relative', e => {
          const s = usePlayerStore.getState();
          const p = getPlaybackProgressSnapshot();
          const dur = s.currentTrack?.duration;
          if (!dur) return;
          s.seek(Math.max(0, p.currentTime + e.payload) / dur);
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }
      {
        const u = await listen<number>('media:seek-absolute', e => {
          const s = usePlayerStore.getState();
          const dur = s.currentTrack?.duration;
          if (!dur) return;
          s.seek(e.payload / dur);
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }
      {
        const u = await listen<number>('media:set-volume', e => {
          const p = e.payload;
          if (typeof p !== 'number' || Number.isNaN(p)) return;
          usePlayerStore.getState().setVolume(Math.min(1, Math.max(0, p / 100)));
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      // Shared exit path: flush play-queue position so other devices can
      // resume from where we left off, tear down any active Orbit session,
      // then ask Rust to exit. Each step is capped at 1500 ms so a slow
      // server can't keep the app hanging on quit; the playback heartbeat
      // is the safety net for anything that didn't make it out in time.
      const performExit = async () => {
        await Promise.race([
          flushPlayQueuePosition(),
          new Promise(r => setTimeout(r, 1500)),
        ]);
        const role = useOrbitStore.getState().role;
        if (role === 'host' || role === 'guest') {
          const teardown = role === 'host' ? endOrbitSession() : leaveOrbitSession();
          await Promise.race([
            teardown.catch(() => {}),
            new Promise(r => setTimeout(r, 1500)),
          ]);
        }
        await invoke('exit_app');
      };

      // window:close-requested is emitted by Rust (prevent_close + emit) on
      // the X-button. JS decides: minimize to tray or exit.
      const u = await listen('window:close-requested', async () => {
        if (useAuthStore.getState().minimizeToTray) {
          await invoke('pause_rendering').catch(() => {});
          await getCurrentWindow().hide();
        } else {
          await performExit();
        }
      });
      if (cancelled) { u(); return; }
      unlisten.push(u);

      // app:force-quit bypasses the minimize-to-tray decision — used by the
      // tray "Exit" menu item and the macOS red close button.
      const fq = await listen('app:force-quit', async () => {
        await performExit();
      });
      if (cancelled) { fq(); return; }
      unlisten.push(fq);
    };

    setup();
    return () => { cancelled = true; unlisten.forEach(u => u()); };
  }, [navigate]);

  // `psysonic --info`: JSON snapshot under XDG_RUNTIME_DIR (Rust writes atomically).
  useEffect(() => {
    let tid: ReturnType<typeof setTimeout> | undefined;
    let lastPublishAt = 0;
    let lastStableKey = '';
    let lastPlaying = false;
    const SNAPSHOT_PLAYING_HEARTBEAT_MS = 4000;
    const SNAPSHOT_IDLE_HEARTBEAT_MS = 15000;
    const publish = () => {
      const s = usePlayerStore.getState();
      const auth = useAuthStore.getState();
      const sid = auth.activeServerId;
      const selected = sid ? (auth.musicLibraryFilterByServer[sid] ?? 'all') : 'all';
      const ct = s.currentTrack;
      const currentTrackUserRating =
        ct != null ? (s.userRatingOverrides[ct.id] ?? ct.userRating ?? null) : null;
      const currentTrackStarred =
        ct != null
          ? (ct.id in s.starredOverrides ? s.starredOverrides[ct.id] : Boolean(ct.starred))
          : null;
      const snapshot = {
        current_track: s.currentTrack,
        current_radio: s.currentRadio,
        queue: s.queue,
        queue_index: s.queueIndex,
        queue_length: s.queue.length,
        is_playing: s.isPlaying,
        current_time: getPlaybackProgressSnapshot().currentTime,
        volume: s.volume,
        repeat_mode: s.repeatMode,
        current_track_user_rating: currentTrackUserRating,
        current_track_starred: currentTrackStarred,
        servers: auth.servers.map(({ id, name }) => ({ id, name })),
        music_library: {
          active_server_id: sid,
          selected,
          folders: auth.musicFolders.map(f => ({ id: f.id, name: f.name })),
        },
      };
      const stableKey = JSON.stringify({
        trackId: s.currentTrack?.id ?? null,
        radioId: s.currentRadio?.id ?? null,
        queueIndex: s.queueIndex,
        queueLength: s.queue.length,
        isPlaying: s.isPlaying,
        volume: Math.round(s.volume * 100),
        repeatMode: s.repeatMode,
        serverId: sid ?? null,
        selected,
        currentTrackUserRating,
        currentTrackStarred,
      });
      const now = Date.now();
      const heartbeatMs = s.isPlaying ? SNAPSHOT_PLAYING_HEARTBEAT_MS : SNAPSHOT_IDLE_HEARTBEAT_MS;
      const stableChanged = stableKey !== lastStableKey;
      const playingEdge = s.isPlaying !== lastPlaying;
      if (!stableChanged && !playingEdge && now - lastPublishAt < heartbeatMs) return;
      lastStableKey = stableKey;
      lastPlaying = s.isPlaying;
      lastPublishAt = now;
      invoke('cli_publish_player_snapshot', { snapshot }).catch(() => {});
    };
    publish();
    const schedule = () => {
      if (tid !== undefined) return;
      tid = setTimeout(() => {
        tid = undefined;
        publish();
      }, 200);
    };
    const unsubP = usePlayerStore.subscribe(schedule);
    const unsubA = useAuthStore.subscribe(schedule);
    return () => {
      unsubP();
      unsubA();
      if (tid !== undefined) clearTimeout(tid);
    };
  }, []);

  return null;
}

export default function App() {
  // Re-subscribe so themeStore changes trigger a re-render (the value itself
  // is consumed via useThemeScheduler / data-theme attribute below).
  useThemeStore(s => s.theme);
  const effectiveTheme = useThemeScheduler();
  const font = useFontStore(s => s.font);

  // Document-attribute hooks are shared between both window kinds — each
  // webview has its own `document`, and theme / font / track-preview tokens
  // are read by CSS in both trees.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
  }, [font]);

  // Hide all inline track-preview buttons when the user opts out — single
  // CSS hook (`html[data-track-previews="off"]`) instead of conditional
  // rendering in every tracklist. Per-location toggles use additional
  // attributes `data-track-previews-{location}` consumed by scoped selectors.
  const trackPreviewsEnabled = useAuthStore(s => s.trackPreviewsEnabled);
  const trackPreviewLocations = useAuthStore(s => s.trackPreviewLocations);
  const trackPreviewDurationSec = useAuthStore(s => s.trackPreviewDurationSec);
  useEffect(() => {
    document.documentElement.setAttribute(
      'data-track-previews',
      trackPreviewsEnabled ? 'on' : 'off',
    );
  }, [trackPreviewsEnabled]);
  useEffect(() => {
    const root = document.documentElement;
    (Object.keys(trackPreviewLocations) as Array<keyof typeof trackPreviewLocations>).forEach(loc => {
      root.setAttribute(`data-track-previews-${loc.toLowerCase()}`, trackPreviewLocations[loc] ? 'on' : 'off');
    });
  }, [trackPreviewLocations]);
  // Drive the SVG progress-ring keyframe duration from the same setting that
  // governs the engine's auto-stop timer so both finish in lockstep.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--preview-duration',
      `${trackPreviewDurationSec}s`,
    );
  }, [trackPreviewDurationSec]);

  return getWindowKind() === 'mini' ? <MiniPlayerApp /> : <MainApp />;
}
