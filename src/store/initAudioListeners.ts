import { getAlbumInfo2 } from '../api/subsonicAlbumInfo';
import { buildCoverArtUrl } from '../api/subsonicStreamUrl';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { streamUrlTrackId } from '../utils/resolvePlaybackUrl';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../utils/loudnessPreAnalysisSlider';
import { normalizationAlmostEqual } from '../utils/normalizationCompare';
import { normalizeAnalysisTrackId } from '../utils/queueIdentity';
import { useAuthStore } from './authStore';
import { onAnalysisStorageChanged } from './analysisSync';
import {
  handleAudioEnded,
  handleAudioError,
  handleAudioPlaying,
  handleAudioProgress,
  handleAudioTrackSwitched,
  type NormalizationStatePayload,
} from './audioEventHandlers';
import {
  clearLoudnessCacheStateForTrackId,
  getCachedLoudnessGain,
  hasStableLoudness,
  setCachedLoudnessGain,
} from './loudnessGainCache';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import { emitNormalizationDebug } from './normalizationDebug';
import { invokeAudioSetNormalizationDeduped } from './normalizationIpcDedupe';
import {
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
} from './playbackProgress';
import {
  NORMALIZATION_UI_THROTTLE_MS,
  getLastNormalizationUiUpdateAtMs,
  markNormalizationUiUpdate,
} from './playbackThrottles';
import { usePlayerStore } from './playerStore';
import { refreshWaveformForTrack } from './waveformRefresh';
import { bumpWaveformRefreshGen } from './waveformRefreshGen';

/**
 * Set up Tauri event listeners for the Rust audio engine.
 * Returns a cleanup function — pass it to useEffect's return value so that
 * React StrictMode (which double-invokes effects in dev) tears down the first
 * set of listeners before creating the second, avoiding duplicate handlers.
 */
export function initAudioListeners(): () => void {
  // Dev-only: warn when audio:progress events arrive faster than 10/s.
  // This would indicate the Rust emit interval was accidentally lowered.
  let _devEventCount = 0;
  let _devWindowStart = 0;

  const pending = [
    listen<number>('audio:playing', ({ payload }) => handleAudioPlaying(payload)),
    listen<{ current_time: number; duration: number }>('audio:progress', ({ payload }) => {
      if (import.meta.env.DEV) {
        _devEventCount++;
        const now = Date.now();
        if (_devWindowStart === 0) _devWindowStart = now;
        if (now - _devWindowStart >= 1000) {
          if (_devEventCount > 10) {
            console.warn(`[psysonic] audio:progress: ${_devEventCount} events/s (threshold: 10) — check Rust emit interval`);
          }
          _devEventCount = 0;
          _devWindowStart = now;
        }
      }
      handleAudioProgress(payload.current_time, payload.duration);
    }),
    listen<void>('audio:ended', () => handleAudioEnded()),
    listen<string>('audio:error', ({ payload }) => handleAudioError(payload)),
    listen<number>('audio:track_switched', ({ payload }) => handleAudioTrackSwitched(payload)),
    listen<{ trackId?: string | null; gainDb: number; targetLufs: number; isPartial: boolean }>('analysis:loudness-partial', ({ payload }) => {
      const current = usePlayerStore.getState().currentTrack;
      if (!current || !payload) return;
      const payloadTrackId = normalizeAnalysisTrackId(payload.trackId);
      if (payloadTrackId && payloadTrackId !== current.id) return;
      if (!Number.isFinite(payload.gainDb)) return;
      if (hasStableLoudness(current.id)) return;
      // Skip when the cached gain is already within ~0.05 dB of the new payload —
      // float jitter from the partial-loudness heuristic would otherwise re-trigger
      // updateReplayGainForCurrentTrack → audio_update_replay_gain → backend echo
      // every PARTIAL_LOUDNESS_EMIT_INTERVAL_MS even when nothing audibly changed.
      const existing = getCachedLoudnessGain(current.id);
      if (Number.isFinite(existing) && Math.abs(existing! - payload.gainDb) < 0.05) return;
      setCachedLoudnessGain(current.id, payload.gainDb);
      emitNormalizationDebug('partial-loudness:apply', {
        trackId: current.id,
        gainDb: payload.gainDb,
        targetLufs: payload.targetLufs,
      });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }),
    listen<{ trackId: string; isPartial: boolean }>('analysis:waveform-updated', ({ payload }) => {
      if (!payload?.trackId) return;
      const payloadTrackId = normalizeAnalysisTrackId(payload.trackId);
      if (!payloadTrackId) return;
      const currentRaw = usePlayerStore.getState().currentTrack?.id;
      const currentId = currentRaw ? normalizeAnalysisTrackId(currentRaw) : null;
      if (currentId && payloadTrackId === currentId) {
        bumpWaveformRefreshGen(currentRaw!);
        void refreshWaveformForTrack(currentRaw!);
        void refreshLoudnessForTrack(currentId);
        emitNormalizationDebug('backfill:applied', { trackId: currentId });
        return;
      }
      // Backfill finished for another id (e.g. next in queue): refresh loudness cache only
      // so the cached gain is ready before `audio_play` / gapless chain.
      void refreshLoudnessForTrack(payloadTrackId, { syncPlayingEngine: false });
      emitNormalizationDebug('backfill:applied', { trackId: payloadTrackId });
    }),
    listen<NormalizationStatePayload>('audio:normalization-state', ({ payload }) => {
      if (!payload) return;
      const engine =
        payload.engine === 'loudness' || payload.engine === 'replaygain'
          ? payload.engine
          : 'off';
      const nowDb = Number.isFinite(payload.currentGainDb as number) ? (payload.currentGainDb as number) : null;
      const targetLufs = Number.isFinite(payload.targetLufs) ? payload.targetLufs : null;
      const prev = usePlayerStore.getState();
      // Avoid UI flicker from noisy duplicate emits and transient nulls.
      if (
        engine === prev.normalizationEngineLive
        && normalizationAlmostEqual(nowDb, prev.normalizationNowDb)
        && normalizationAlmostEqual(targetLufs, prev.normalizationTargetLufs, 0.02)
      ) {
        return;
      }
      if (engine === 'loudness' && nowDb == null && prev.normalizationNowDb != null) {
        return;
      }
      const nowMs = Date.now();
      const isFirstNumericGain =
        engine === 'loudness'
        && nowDb != null
        && prev.normalizationNowDb == null;
      if (
        !isFirstNumericGain
        && nowMs - getLastNormalizationUiUpdateAtMs() < NORMALIZATION_UI_THROTTLE_MS
        && engine === prev.normalizationEngineLive
      ) {
        return;
      }
      markNormalizationUiUpdate(nowMs);
      emitNormalizationDebug('event:audio:normalization-state', {
        trackId: usePlayerStore.getState().currentTrack?.id ?? null,
        payload,
      });
      usePlayerStore.setState({
        normalizationEngineLive: engine,
        normalizationNowDb: nowDb,
        normalizationTargetLufs: targetLufs,
        normalizationDbgSource: 'event:audio:normalization-state',
        normalizationDbgLastEventAt: Date.now(),
      });
    }),
    listen<string>('audio:preload-ready', ({ payload }) => {
      const tid = streamUrlTrackId(payload);
      if (import.meta.env.DEV) {
        console.info('[psysonic][preload-ready]', {
          payload,
          parsedTrackId: tid,
          prevEnginePreloadedTrackId: usePlayerStore.getState().enginePreloadedTrackId,
        });
      }
      if (tid) usePlayerStore.setState({ enginePreloadedTrackId: tid });
      else if (import.meta.env.DEV) {
        console.warn('[psysonic][preload-ready] could not parse track id from payload URL');
      }
    }),
  ];

  // Sync Last.fm loved tracks cache on startup.
  usePlayerStore.getState().syncLastfmLovedTracks();

  // Initial sync of audio settings to Rust engine on startup.
  const { crossfadeEnabled, crossfadeSecs, gaplessEnabled, audioOutputDevice } = useAuthStore.getState();
  invoke('audio_set_crossfade', { enabled: crossfadeEnabled, secs: crossfadeSecs }).catch(() => {});
  invoke('audio_set_gapless', { enabled: gaplessEnabled }).catch(() => {});
  const normCfg = useAuthStore.getState();
  usePlayerStore.setState({
    normalizationEngineLive: normCfg.normalizationEngine,
    normalizationTargetLufs: normCfg.normalizationEngine === 'loudness' ? normCfg.loudnessTargetLufs : null,
    normalizationNowDb: null,
    normalizationDbgSource: 'init:set-normalization',
  });
  emitNormalizationDebug('init:set-normalization', {
    engine: normCfg.normalizationEngine,
    targetLufs: normCfg.loudnessTargetLufs,
    currentTrackId: usePlayerStore.getState().currentTrack?.id ?? null,
  });
  invokeAudioSetNormalizationDeduped({
    engine: normCfg.normalizationEngine,
    targetLufs: normCfg.loudnessTargetLufs,
    preAnalysisAttenuationDb: effectiveLoudnessPreAnalysisAttenuationDb(
      normCfg.loudnessPreAnalysisAttenuationDb,
      normCfg.loudnessTargetLufs,
    ),
  });
  const bootTrackId = usePlayerStore.getState().currentTrack?.id;
  if (bootTrackId) {
    void refreshWaveformForTrack(bootTrackId);
  }
  if (normCfg.normalizationEngine === 'loudness') {
    const currentId = usePlayerStore.getState().currentTrack?.id;
    if (currentId) {
      void refreshLoudnessForTrack(currentId).finally(() => {
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      });
    }
  }
  if (audioOutputDevice) {
    invoke('audio_set_device', { deviceName: audioOutputDevice }).catch(() => {});
  }

  // Keep audio settings in sync whenever auth store changes.
  let prevNormEngine = normCfg.normalizationEngine;
  let prevNormTarget = normCfg.loudnessTargetLufs;
  let prevPreAnalysis = normCfg.loudnessPreAnalysisAttenuationDb;
  const unsubAuth = useAuthStore.subscribe((state) => {
    invoke('audio_set_crossfade', {
      enabled: state.crossfadeEnabled,
      secs: state.crossfadeSecs,
    }).catch(() => {});
    invoke('audio_set_gapless', { enabled: state.gaplessEnabled }).catch(() => {});
    const normChanged =
      state.normalizationEngine !== prevNormEngine
      || state.loudnessTargetLufs !== prevNormTarget
      || state.loudnessPreAnalysisAttenuationDb !== prevPreAnalysis;
    if (!normChanged) return;
    const onlyPreAnalysisChanged =
      state.normalizationEngine === prevNormEngine
      && state.loudnessTargetLufs === prevNormTarget
      && state.loudnessPreAnalysisAttenuationDb !== prevPreAnalysis;
    const targetLufsChanged =
      state.normalizationEngine === 'loudness'
      && state.loudnessTargetLufs !== prevNormTarget;
    prevNormEngine = state.normalizationEngine;
    prevNormTarget = state.loudnessTargetLufs;
    prevPreAnalysis = state.loudnessPreAnalysisAttenuationDb;
    usePlayerStore.setState({
      normalizationEngineLive: state.normalizationEngine,
      normalizationTargetLufs: state.normalizationEngine === 'loudness' ? state.loudnessTargetLufs : null,
      normalizationNowDb: state.normalizationEngine === 'loudness'
        ? usePlayerStore.getState().normalizationNowDb
        : null,
      normalizationDbgSource: 'auth:normalization-changed',
    });
    emitNormalizationDebug('auth:normalization-changed', {
      engine: state.normalizationEngine,
      targetLufs: state.loudnessTargetLufs,
      currentTrackId: usePlayerStore.getState().currentTrack?.id ?? null,
    });
    invokeAudioSetNormalizationDeduped({
      engine: state.normalizationEngine,
      targetLufs: state.loudnessTargetLufs,
      preAnalysisAttenuationDb: effectiveLoudnessPreAnalysisAttenuationDb(
        state.loudnessPreAnalysisAttenuationDb,
        state.loudnessTargetLufs,
      ),
    });
    if (state.normalizationEngine === 'loudness') {
      const currentId = usePlayerStore.getState().currentTrack?.id;
      if (onlyPreAnalysisChanged) {
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      } else if (currentId) {
        if (targetLufsChanged) {
          clearLoudnessCacheStateForTrackId(currentId);
        }
        void refreshLoudnessForTrack(currentId).finally(() => {
          usePlayerStore.getState().updateReplayGainForCurrentTrack();
        });
      }
    } else {
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }
  });
  const unsubAnalysisSync = onAnalysisStorageChanged(detail => {
    const currentId = usePlayerStore.getState().currentTrack?.id;
    if (!currentId) return;
    if (detail.trackId && detail.trackId !== currentId) return;
    bumpWaveformRefreshGen(currentId);
    void refreshWaveformForTrack(currentId);
    void refreshLoudnessForTrack(currentId);
  });

  // ── MPRIS / OS media controls sync ───────────────────────────────────────
  // Whenever the current track or playback state changes, push updates to the
  // Rust souvlaki MediaControls so the OS media overlay stays accurate.
  let prevTrackId: string | null = null;
  let prevRadioId: string | null = null;
  let prevIsPlaying: boolean | null = null;
  let lastMprisPositionUpdate = 0;

  const unsubMpris = usePlayerStore.subscribe((state) => {
    const { currentTrack, currentRadio, isPlaying } = state;

    // Update metadata when track changes
    if (currentTrack && currentTrack.id !== prevTrackId) {
      prevTrackId = currentTrack.id;
      prevRadioId = null;
      const coverUrl = currentTrack.coverArt
        ? buildCoverArtUrl(currentTrack.coverArt, 512)
        : undefined;
      invoke('mpris_set_metadata', {
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        coverUrl,
        durationSecs: currentTrack.duration,
      }).catch(() => {});
    }

    // Update metadata when a radio station starts (initial push — station name as title).
    // ICY StreamTitle updates are forwarded by the radio:metadata listener below.
    if (currentRadio && currentRadio.id !== prevRadioId) {
      prevRadioId = currentRadio.id;
      prevTrackId = null;
      invoke('mpris_set_metadata', {
        title: currentRadio.name,
        artist: null,
        album: null,
        coverUrl: null,
        durationSecs: null,
      }).catch(() => {});
    }

    // Update playback state on play/pause change (use live snapshot — persisted
    // store currentTime is intentionally coarse between commits).
    const playbackChanged = isPlaying !== prevIsPlaying;
    if (playbackChanged) {
      prevIsPlaying = isPlaying;
      lastMprisPositionUpdate = Date.now();
      const pos = getPlaybackProgressSnapshot().currentTime;
      invoke('mpris_set_playback', {
        playing: isPlaying,
        positionSecs: pos > 0 ? pos : null,
      }).catch(() => {});
      invoke('update_taskbar_icon', { isPlaying }).catch(() => {});
      return;
    }
  });
  const unsubMprisProgress = subscribePlaybackProgress(({ currentTime }) => {
    const { currentRadio, isPlaying } = usePlayerStore.getState();
    if (currentRadio || !isPlaying) return;
    if (Date.now() - lastMprisPositionUpdate < 1500) return;
    lastMprisPositionUpdate = Date.now();
    invoke('mpris_set_playback', {
      playing: true,
      positionSecs: currentTime,
    }).catch(() => {});
  });

  // ── Radio ICY StreamTitle → MPRIS ─────────────────────────────────────────
  // The Rust download task emits "radio:metadata" with { title, is_ad } every
  // time an ICY metadata block changes (typically every 8–32 KB of audio).
  // Forward each update to mpris_set_metadata so the OS now-playing overlay
  // stays in sync while the stream is live.
  const radioMetaUnlisten = listen<{ title: string; is_ad: boolean }>('radio:metadata', ({ payload }) => {
    const { currentRadio } = usePlayerStore.getState();
    if (!currentRadio) return; // guard: only forward during active radio session
    if (payload.is_ad) return; // skip CDN-injected ad metadata

    // Parse "Artist - Title" convention used by most ICY streams.
    const sep = payload.title.indexOf(' - ');
    const artist = sep !== -1 ? payload.title.slice(0, sep).trim() : null;
    const title  = sep !== -1 ? payload.title.slice(sep + 3).trim() : payload.title;

    invoke('mpris_set_metadata', {
      title: title || currentRadio.name,
      artist: artist || currentRadio.name,
      album: null,
      coverUrl: null,
      durationSecs: null,
    }).catch(() => {});
  });

  // ── Discord Rich Presence sync ────────────────────────────────────────────
  // Updates on track change or play/pause toggle. No per-tick updates needed —
  // Discord auto-counts up the elapsed timer from the start_timestamp we set.
  let discordPrevTrackId: string | null = null;
  let discordPrevIsPlaying: boolean | null = null;
  let discordPrevFetchCovers: boolean | null = null;
  let discordPrevTemplateDetails: string | null = null;
  let discordPrevTemplateState: string | null = null;
  let discordPrevTemplateLargeText: string | null = null;
  let discordPrevCoverSource: string | null = null;
  const discordServerCoverCache = new Map<string, string | null>();

  function syncDiscord() {
    const { currentTrack, isPlaying } = usePlayerStore.getState();
    const currentTime = getPlaybackProgressSnapshot().currentTime;
    const {
      discordRichPresence,
      discordCoverSource,
      discordTemplateDetails,
      discordTemplateState,
      discordTemplateLargeText,
    } = useAuthStore.getState();

    if (!discordRichPresence || !currentTrack) {
      if (discordPrevTrackId !== null) {
        discordPrevTrackId = null;
        discordPrevIsPlaying = null;
        discordPrevFetchCovers = null;
        discordPrevCoverSource = null;
        discordPrevTemplateDetails = null;
        discordPrevTemplateState = null;
        discordPrevTemplateLargeText = null;
        invoke('discord_clear_presence').catch(() => {});
      }
      return;
    }

    const trackChanged = currentTrack.id !== discordPrevTrackId;
    const playingChanged = isPlaying !== discordPrevIsPlaying;
    const coverSourceChanged = discordCoverSource !== discordPrevCoverSource;
    const detailsTemplateChanged = discordTemplateDetails !== discordPrevTemplateDetails;
    const stateTemplateChanged = discordTemplateState !== discordPrevTemplateState;
    const largeTextTemplateChanged = discordTemplateLargeText !== discordPrevTemplateLargeText;
    if (!trackChanged && !playingChanged && !coverSourceChanged && !detailsTemplateChanged && !stateTemplateChanged && !largeTextTemplateChanged) return;

    discordPrevTrackId = currentTrack.id;
    discordPrevIsPlaying = isPlaying;
    discordPrevFetchCovers = discordCoverSource === 'apple';
    discordPrevCoverSource = discordCoverSource;
    discordPrevTemplateDetails = discordTemplateDetails;
    discordPrevTemplateState = discordTemplateState;
    discordPrevTemplateLargeText = discordTemplateLargeText;

    const sendPresence = (coverArtUrl: string | null) => {
      invoke('discord_update_presence', {
        title: currentTrack.title,
        artist: currentTrack.artist ?? 'Unknown Artist',
        album: currentTrack.album ?? null,
        isPlaying,
        elapsedSecs: isPlaying ? currentTime : null,
        coverArtUrl,
        fetchItunesCovers: discordCoverSource === 'apple',
        detailsTemplate: discordTemplateDetails,
        stateTemplate: discordTemplateState,
        largeTextTemplate: discordTemplateLargeText,
      }).catch(() => {});
    };

    if (discordCoverSource === 'server' && currentTrack.albumId) {
      const cached = discordServerCoverCache.get(currentTrack.albumId);
      if (cached !== undefined) {
        sendPresence(cached);
      } else {
        getAlbumInfo2(currentTrack.albumId).then(info => {
          const url = info?.largeImageUrl || info?.mediumImageUrl || info?.smallImageUrl || null;
          discordServerCoverCache.set(currentTrack.albumId, url);
          sendPresence(url);
        });
      }
    } else {
      sendPresence(null);
    }
  }

  const unsubDiscordPlayer = usePlayerStore.subscribe(syncDiscord);
  const unsubDiscordAuth = useAuthStore.subscribe(syncDiscord);

  return () => {
    unsubAuth();
    unsubAnalysisSync();
    unsubMpris();
    unsubMprisProgress();
    unsubDiscordPlayer();
    unsubDiscordAuth();
    pending.forEach(p => p.then(unlisten => unlisten()));
    radioMetaUnlisten.then(unlisten => unlisten());
  };
}
