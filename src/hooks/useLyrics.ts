import type { SubsonicStructuredLyrics } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { fetchLyrics, parseLrc, LrcLine } from '../api/lrclib';
import { fetchNeteaselyrics } from '../api/netease';
import { getLyricsBySongId } from '../api/subsonic';
import { fetchLyricsPlus, hasWordSync } from '../api/lyricsplus';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { useHotCacheStore } from '../store/hotCacheStore';
import { getCachedLyrics, putCachedLyrics, lyricsCacheKey } from '../utils/lyricsPersistentCache';
export type LyricsSource = 'server' | 'lrclib' | 'netease' | 'embedded' | 'lyricsplus';

/**
 * Karaoke-style word/syllable timing inside a single line.
 * All times are seconds (aligned with `LrcLine.time`), converted from the
 * millisecond-based lyricsplus response.
 */
export interface WordLyricsWord {
  text: string;
  time: number;
  duration: number;
}

export interface WordLyricsLine {
  time: number;
  duration: number;
  text: string;
  words: WordLyricsWord[];
}

export interface CachedLyrics {
  syncedLines: LrcLine[] | null;
  wordLines: WordLyricsLine[] | null;
  plainLyrics: string | null;
  source: LyricsSource | null;
  notFound: boolean;
}

// L1 cache: RAM, survives tab switches and component remount within a session.
// L2 (IndexedDB) lives in `utils/lyricsPersistentCache.ts` — only touched on
// L1 miss so the common case (jumping back to a recent track) stays fully sync.
export const lyricsCache = new Map<string, CachedLyrics>();

/** Convert structured Subsonic lyrics (ms timestamps) into LrcLine[] or plain text. */
export function parseStructuredLyrics(
  lyrics: SubsonicStructuredLyrics,
): Pick<CachedLyrics, 'syncedLines' | 'plainLyrics'> {
  // Accept both `synced` (OpenSubsonic spec) and `issynced` (legacy servers).
  const isSynced = !!(lyrics.synced ?? lyrics.issynced);
  if (isSynced && lyrics.line.length > 0) {
    const lines: LrcLine[] = lyrics.line
      .filter(l => l.start !== undefined)
      .map(l => ({ time: l.start! / 1000, text: l.value.trim() }))
      .sort((a, b) => a.time - b.time);
    if (lines.length > 0) return { syncedLines: lines, plainLyrics: null };
  }
  const plain = lyrics.line.map(l => l.value).join('\n').trim();
  return { syncedLines: null, plainLyrics: plain || null };
}

export interface UseLyricsResult {
  syncedLines: LrcLine[] | null;
  wordLines: WordLyricsLine[] | null;
  plainLyrics: string | null;
  source: LyricsSource | null;
  loading: boolean;
  notFound: boolean;
}

export function useLyrics(currentTrack: Track | null): UseLyricsResult {
  const cached = currentTrack ? lyricsCache.get(currentTrack.id) : undefined;
  const { lyricsSources, lyricsMode } = useAuthStore(useShallow(s => ({
    lyricsSources: s.lyricsSources,
    lyricsMode: s.lyricsMode,
  })));

  const [loading, setLoading]         = useState(!cached && !!currentTrack);
  const [syncedLines, setSyncedLines] = useState<LrcLine[] | null>(cached?.syncedLines ?? null);
  const [wordLines, setWordLines]     = useState<WordLyricsLine[] | null>(cached?.wordLines ?? null);
  const [plainLyrics, setPlainLyrics] = useState<string | null>(cached?.plainLyrics ?? null);
  const [source, setSource]           = useState<LyricsSource | null>(cached?.source ?? null);
  const [notFound, setNotFound]       = useState(cached?.notFound ?? false);

  useEffect(() => {
    if (!currentTrack) return;

    const hit = lyricsCache.get(currentTrack.id);
    if (hit) {
      setSyncedLines(hit.syncedLines);
      setWordLines(hit.wordLines);
      setPlainLyrics(hit.plainLyrics);
      setSource(hit.source);
      setNotFound(hit.notFound);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setSyncedLines(null);
    setWordLines(null);
    setPlainLyrics(null);
    setSource(null);
    setNotFound(false);
    setLoading(true);

    const applyEntry = (entry: CachedLyrics) => {
      if (cancelled) return;
      lyricsCache.set(currentTrack.id, entry);
      setSyncedLines(entry.syncedLines);
      setWordLines(entry.wordLines);
      setPlainLyrics(entry.plainLyrics);
      setSource(entry.source);
      setNotFound(entry.notFound);
      setLoading(false);
    };

    const store = (entry: CachedLyrics) => {
      if (cancelled) return;
      applyEntry(entry);
      // Persist for the next session (fire-and-forget — failures are silent).
      const serverId = useAuthStore.getState().activeServerId ?? '';
      putCachedLyrics(lyricsCacheKey(serverId, currentTrack.id), entry);
    };

    // For offline / hot-cached tracks we have the file locally — read SYLT /
    // SYNCEDLYRICS directly via Rust instead of relying on Navidrome's parsing.
    // Fast path: both store lookups are synchronous; returns false immediately
    // for streaming tracks so it has zero impact on the normal fetch sequence.
    const fetchEmbedded = async (): Promise<boolean> => {
      const serverId = useAuthStore.getState().activeServerId ?? '';
      const localUrl =
        useOfflineStore.getState().getLocalUrl(currentTrack.id, serverId) ??
        useHotCacheStore.getState().getLocalUrl(currentTrack.id, serverId);
      if (!localUrl) return false;

      const prefix = 'psysonic-local://';
      const filePath = localUrl.startsWith(prefix) ? localUrl.slice(prefix.length) : null;
      if (!filePath) return false;

      try {
        const lrcString = await invoke<string | null>('get_embedded_lyrics', { path: filePath });
        if (!lrcString) return false;

        const lines = parseLrc(lrcString);
        const synced = lines.length > 0 ? lines : null;
        const plain  = synced ? null : (lrcString.trim() || null);
        if (!synced && !plain) return false;

        store({ syncedLines: synced, wordLines: null, plainLyrics: plain, source: 'embedded', notFound: false });
        return true;
      } catch {
        return false;
      }
    };

    const fetchServer = async (): Promise<boolean> => {
      const structured = await getLyricsBySongId(currentTrack.id);
      if (!structured) return false;
      const parsed = parseStructuredLyrics(structured);
      if (!parsed.syncedLines && !parsed.plainLyrics) return false;
      store({ ...parsed, wordLines: null, source: 'server', notFound: false });
      return true;
    };

    const fetchLrclibFn = async (): Promise<boolean> => {
      try {
        const result = await fetchLyrics(
          currentTrack.artist ?? '',
          currentTrack.title,
          currentTrack.album ?? '',
          currentTrack.duration ?? 0,
        );
        if (!result || (!result.syncedLyrics && !result.plainLyrics)) return false;
        const lines = result.syncedLyrics ? parseLrc(result.syncedLyrics) : null;
        const synced = lines && lines.length > 0 ? lines : null;
        store({ syncedLines: synced, wordLines: null, plainLyrics: result.plainLyrics, source: 'lrclib', notFound: false });
        return true;
      } catch {
        return false;
      }
    };

    const NETEASE_META = /^(作词|作曲|编曲|制作人|出版|发行|MV导演|录音|混音|监制)/;
    const fetchNetease = async (): Promise<boolean> => {
      try {
        const lrc = await fetchNeteaselyrics(currentTrack.artist ?? '', currentTrack.title);
        if (!lrc) return false;
        const lines = parseLrc(lrc).filter(l => !NETEASE_META.test(l.text));
        const synced = lines.length > 0 ? lines : null;
        if (!synced) return false;
        store({ syncedLines: synced, wordLines: null, plainLyrics: null, source: 'netease', notFound: false });
        return true;
      } catch {
        return false;
      }
    };

    /**
     * lyricsplus (YouLyPlus). Silent miss → caller falls back to the standard
     * pipeline. Only consumed when `lyricsMode === 'lyricsplus'`.
     */
    const fetchLyricsPlusFn = async (): Promise<boolean> => {
      try {
        const result = await fetchLyricsPlus({
          title: currentTrack.title,
          artist: currentTrack.artist ?? '',
          album: currentTrack.album ?? undefined,
          durationSec: currentTrack.duration ?? undefined,
        });
        if (!result || result.lyrics.length === 0) return false;

        const hasWords = hasWordSync(result);
        const syncedLines: LrcLine[] = result.lyrics
          .map(l => ({ time: l.time / 1000, text: l.text }))
          .sort((a, b) => a.time - b.time);

        const wordLines: WordLyricsLine[] | null = hasWords
          ? result.lyrics.map(l => ({
              time: l.time / 1000,
              duration: l.duration / 1000,
              text: l.text,
              words: (l.syllabus ?? []).map(w => ({
                text: w.text,
                time: w.time / 1000,
                duration: w.duration / 1000,
              })),
            }))
          : null;

        store({
          syncedLines: syncedLines.length > 0 ? syncedLines : null,
          wordLines,
          plainLyrics: null,
          source: 'lyricsplus',
          notFound: false,
        });
        return true;
      } catch {
        return false;
      }
    };

    const fetchFns: Record<string, () => Promise<boolean>> = {
      server: fetchServer,
      lrclib: fetchLrclibFn,
      netease: fetchNetease,
    };

    (async () => {
      // Embedded lyrics from local file always win (most accurate SYLT data).
      if (cancelled) return;
      if (await fetchEmbedded()) return;

      // L2: IndexedDB — re-hydrates RAM cache without a network roundtrip.
      // Skip for 'lyricsplus' mode since the persisted entry might be from
      // the standard pipeline (no word-level sync) and the user explicitly
      // wants a fresh lyricsplus attempt.
      if (lyricsMode !== 'lyricsplus') {
        const serverId = useAuthStore.getState().activeServerId ?? '';
        const persisted = await getCachedLyrics(lyricsCacheKey(serverId, currentTrack.id));
        if (cancelled) return;
        if (persisted) {
          // Don't re-write to L2 (it's already there); just hydrate RAM + UI.
          lyricsCache.set(currentTrack.id, persisted);
          applyEntry(persisted);
          return;
        }
      }

      // YouLyPlus mode: try lyricsplus first, silent fallback to standard.
      if (lyricsMode === 'lyricsplus') {
        if (cancelled) return;
        if (await fetchLyricsPlusFn()) return;
      }

      // Standard pipeline — try enabled sources in user-defined order.
      for (const src of lyricsSources) {
        if (!src.enabled) continue;
        const fn = fetchFns[src.id];
        if (!fn) continue;
        if (cancelled) return;
        if (await fn()) return;
      }
      if (!cancelled) store({ syncedLines: null, wordLines: null, plainLyrics: null, source: null, notFound: true });
    })();

    return () => { cancelled = true; };
  }, [currentTrack?.id, lyricsSources, lyricsMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return { syncedLines, wordLines, plainLyrics, source, loading, notFound };
}
