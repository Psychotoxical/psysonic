import type { InternetRadioStation } from '../api/subsonicTypes';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePerfProbeFlags } from '../utils/perfFlags';
import {
  guessAzuraCastApiUrl,
  normaliseAzuraCastHomepageUrl,
  fetchAzuraCastNowPlaying,
  type AzuraCastNowPlaying,
  type AzuraCastSong,
} from '../api/azuracast';

// ─── Public types ─────────────────────────────────────────────────────────────

export type RadioMetadataSource = 'azuracast' | 'icy' | 'none';

export interface RadioHistoryItem {
  song: AzuraCastSong;
  playedAt?: number; // unix timestamp
}

export interface RadioMetadata {
  /** Metadata source that is currently active. */
  source: RadioMetadataSource;
  /** Station name (from ICY icy-name or AzuraCast station.name). */
  stationName?: string;
  /** Current track title (combined or individual fields). */
  currentTitle?: string;
  currentArtist?: string;
  currentAlbum?: string;
  currentArt?: string;
  /** AzuraCast-only: seconds elapsed in current track. */
  elapsed?: number;
  /** AzuraCast-only: total duration of current track in seconds. */
  duration?: number;
  /** AzuraCast-only: number of current listeners. */
  listeners?: number;
  /** AzuraCast-only: last N played tracks. */
  history: RadioHistoryItem[];
  /** AzuraCast-only: next track queued. */
  nextSong?: AzuraCastSong;
}

// ─── ICY metadata interface (matches Rust IcyMetadata struct) ─────────────────

interface IcyMetadataResult {
  stream_title?: string;
  icy_name?: string;
  icy_genre?: string;
  icy_url?: string;
  icy_description?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseIcyStreamTitle(streamTitle: string): { artist?: string; title: string } {
  const sep = streamTitle.indexOf(' - ');
  if (sep !== -1) {
    return { artist: streamTitle.slice(0, sep).trim(), title: streamTitle.slice(sep + 3).trim() };
  }
  return { title: streamTitle };
}

function nowPlayingToMetadata(np: AzuraCastNowPlaying): RadioMetadata {
  const nowPlaying = np.now_playing;
  const song = nowPlaying?.song;
  return {
    source: 'azuracast',
    stationName: np.station?.name,
    currentTitle: song?.title,
    currentArtist: song?.artist,
    currentAlbum: song?.album,
    currentArt: song?.art,
    elapsed: nowPlaying?.elapsed,
    duration: nowPlaying?.duration,
    listeners: np.listeners?.current,
    history: (np.song_history ?? []).slice(0, 5).map(h => ({
      song: h.song,
      playedAt: h.played_at,
    })),
    nextSong: np.playing_next?.song ?? undefined,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const AZURACAST_POLL_MS = 15_000;
const ICY_POLL_MS       = 30_000;
const EMPTY_METADATA: RadioMetadata = { source: 'none', history: [] };

export function useRadioMetadata(station: InternetRadioStation | null): RadioMetadata {
  const perfFlags = usePerfProbeFlags();
  const [metadata, setMetadata] = useState<RadioMetadata>(EMPTY_METADATA);

  // Keep elapsed in sync while AzuraCast is active: advance 1 s/tick while playing.
  const elapsedRef         = useRef<number | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stationRef         = useRef<InternetRadioStation | null>(null);

  // Store resolved AzuraCast API URL for the current station (or null).
  const azuraCastUrlRef = useRef<string | null>(null);

  // Stop the elapsed ticker.
  function stopElapsedTick() {
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
    elapsedRef.current = null;
  }

  // Start a 1-second elapsed ticker that advances the stored elapsed value and
  // updates the metadata state so the progress bar moves smoothly between polls.
  function startElapsedTick(initial: number) {
    stopElapsedTick();
    elapsedRef.current = initial;
    elapsedIntervalRef.current = setInterval(() => {
      if (elapsedRef.current === null) return;
      elapsedRef.current += 1;
      setMetadata(prev =>
        prev.source === 'azuracast'
          ? { ...prev, elapsed: elapsedRef.current! }
          : prev
      );
    }, 1000);
  }

  useEffect(() => {
    if (perfFlags.disableBackgroundPolling) {
      setMetadata(EMPTY_METADATA);
      azuraCastUrlRef.current = null;
      stopElapsedTick();
      return;
    }
    if (!station) {
      setMetadata(EMPTY_METADATA);
      azuraCastUrlRef.current = null;
      stopElapsedTick();
      return;
    }

    stationRef.current = station;
    setMetadata(EMPTY_METADATA);
    azuraCastUrlRef.current = null;
    stopElapsedTick();

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    // Determine which AzuraCast API URL to try, in priority order:
    //   1. Homepage URL if it matches the /api/nowplaying[/shortcode] pattern
    //   2. Guessed URL from stream URL path (/listen/<shortcode>/…)
    const candidateApiUrl =
      (station.homepageUrl ? normaliseAzuraCastHomepageUrl(station.homepageUrl) : null) ??
      guessAzuraCastApiUrl(station.streamUrl);

    async function pollAzuraCast(apiUrl: string) {
      if (cancelled) return;
      const np = await fetchAzuraCastNowPlaying(apiUrl);
      if (cancelled) return;
      if (np) {
        const m = nowPlayingToMetadata(np);
        setMetadata(m);
        startElapsedTick(m.elapsed ?? 0);
        pollTimer = setTimeout(() => pollAzuraCast(apiUrl), AZURACAST_POLL_MS);
      } else {
        // AzuraCast check failed — fall back to ICY
        azuraCastUrlRef.current = null;
        pollIcy();
      }
    }

    async function pollIcy() {
      if (cancelled) return;
      const currentStation = stationRef.current;
      if (!currentStation) return;
      try {
        const result: IcyMetadataResult = await invoke('fetch_icy_metadata', { url: currentStation.streamUrl });
        if (cancelled) return;
        if (result.stream_title || result.icy_name) {
          const parsed = result.stream_title ? parseIcyStreamTitle(result.stream_title) : null;
          setMetadata({
            source: 'icy',
            stationName: result.icy_name,
            currentTitle: parsed?.title,
            currentArtist: parsed?.artist,
            history: [],
          });
        }
      } catch {
        // ICY metadata not available — leave empty metadata
      }
      if (!cancelled) {
        pollTimer = setTimeout(pollIcy, ICY_POLL_MS);
      }
    }

    // Kick off detection and polling.
    if (candidateApiUrl) {
      // Try AzuraCast first; fall back to ICY inside pollAzuraCast if it fails.
      azuraCastUrlRef.current = candidateApiUrl;
      pollAzuraCast(candidateApiUrl);
    } else {
      pollIcy();
    }

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      stopElapsedTick();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station?.id, station?.streamUrl, station?.homepageUrl, perfFlags.disableBackgroundPolling]);

  return metadata;
}
