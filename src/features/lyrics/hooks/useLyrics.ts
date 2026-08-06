import { getLyricsBySongId } from '@/lib/api/subsonicLyrics';
import type { Track } from '@/lib/media/trackTypes';
import { useEffect, useState } from 'react';
import { commands } from '@/generated/bindings';
import { fetchLyrics } from '@/features/lyrics/api/lrclib';
import { parseEnhancedLrc, parseLrc } from '@/features/lyrics/utils/lrc';
import { fetchNeteaselyrics } from '@/features/lyrics/api/netease';
import { useAuthStore } from '@/store/authStore';
import { useOfflineStore } from '@/features/offline';
import { useHotCacheStore } from '@/features/playback/store/hotCacheStore';
import { getCachedLyrics, putCachedLyrics, lyricsCacheKey } from '@/features/lyrics/utils/lyricsPersistentCache';
import { parseStructuredLyrics, parseStructuredWordLines } from '@/features/lyrics/utils/structuredLyrics';
import { FEATURE_ENHANCED_LYRICS } from '@/lib/serverCapabilities/catalog';
import { isFeatureActiveForServer } from '@/lib/serverCapabilities/storeView';
import type { CachedLyrics, LrcLine, LyricsSource, WordLyricsLine } from '@/features/lyrics/types';
import { playbackCacheKeyForTrack, playbackProfileIdForTrack } from '@/features/playback';

// L1 cache: RAM, survives tab switches and component remount within a session.
// L2 (IndexedDB) lives in `utils/lyricsPersistentCache.ts` — only touched on
// L1 miss so the common case (jumping back to a recent track) stays fully sync.
export const lyricsCache = new Map<string, CachedLyrics>();

export interface UseLyricsResult {
  syncedLines: LrcLine[] | null;
  wordLines: WordLyricsLine[] | null;
  plainLyrics: string | null;
  source: LyricsSource | null;
  loading: boolean;
  notFound: boolean;
}

export function useLyrics(currentTrack: Track | null): UseLyricsResult {
  const lyricsSources = useAuthStore(s => s.lyricsSources);
  // Lyrics are fully off when no source is enabled.
  const lyricsActive = lyricsSources.some(s => s.enabled);
  const ownerServerKey = currentTrack ? playbackCacheKeyForTrack(currentTrack) : '';
  const ownerServerId = currentTrack ? playbackProfileIdForTrack(currentTrack) : '';
  const cacheKey = currentTrack ? lyricsCacheKey(ownerServerKey, currentTrack.id) : '';
  const cached = (currentTrack && lyricsActive) ? lyricsCache.get(cacheKey) : undefined;

  const [loading, setLoading]         = useState(!cached && !!currentTrack);
  const [syncedLines, setSyncedLines] = useState<LrcLine[] | null>(cached?.syncedLines ?? null);
  const [wordLines, setWordLines]     = useState<WordLyricsLine[] | null>(cached?.wordLines ?? null);
  const [plainLyrics, setPlainLyrics] = useState<string | null>(cached?.plainLyrics ?? null);
  const [source, setSource]           = useState<LyricsSource | null>(cached?.source ?? null);
  const [notFound, setNotFound]       = useState(cached?.notFound ?? false);

  useEffect(() => {
    if (!currentTrack) return;

    // Lyrics fully disabled (every source off): fetch nothing,
    // show nothing — not even embedded/cache (issue #810). LyricsPane surfaces
    // the "no sources selected" hint.
    if (!lyricsActive) {
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSyncedLines(null);
      setWordLines(null);
      setPlainLyrics(null);
      setSource(null);
      setNotFound(false);
      setLoading(false);
      return;
    }

    const hit = lyricsCache.get(cacheKey);
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
      lyricsCache.set(cacheKey, entry);
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
      putCachedLyrics(cacheKey, entry);
    };

    // For offline / hot-cached tracks we have the file locally — read SYLT /
    // SYNCEDLYRICS directly via Rust instead of relying on Navidrome's parsing.
    // Fast path: both store lookups are synchronous; returns false immediately
    // for streaming tracks so it has zero impact on the normal fetch sequence.
    const fetchEmbedded = async (): Promise<boolean> => {
      const localUrl =
        useOfflineStore.getState().getLocalUrl(currentTrack.id, ownerServerKey) ??
        useHotCacheStore.getState().getLocalUrl(currentTrack.id, ownerServerKey);
      if (!localUrl) return false;

      const prefix = 'psysonic-local://';
      const filePath = localUrl.startsWith(prefix) ? localUrl.slice(prefix.length) : null;
      if (!filePath) return false;

      try {
        const lrcString = await commands.getEmbeddedLyrics(filePath);
        if (!lrcString) return false;

        // Embedded tags may hold Enhanced LRC, whose inline `<mm:ss.xx>` markers
        // must not reach the text — and can drive word highlighting when present.
        const { lines, wordLines } = parseEnhancedLrc(lrcString);
        const synced = lines.length > 0 ? lines : null;
        const plain  = synced ? null : (lrcString.trim() || null);
        if (!synced && !plain) return false;

        store({ syncedLines: synced, wordLines: synced ? wordLines : null, plainLyrics: plain, source: 'embedded', notFound: false });
        return true;
      } catch {
        return false;
      }
    };

    const fetchServer = async (): Promise<boolean> => {
      // `songLyrics` v2 adds word-level cues, but only where the catalog says the
      // server speaks it. On a v1 server this stays a plain v1 request.
      const enhanced = !!ownerServerId && isFeatureActiveForServer(ownerServerId, FEATURE_ENHANCED_LYRICS);

      const structured = await getLyricsBySongId(currentTrack.id, {
        enhanced,
        serverId: ownerServerId || undefined,
      });
      if (!structured) return false;
      const parsed = parseStructuredLyrics(structured);
      if (!parsed.syncedLines && !parsed.plainLyrics) return false;
      const wordLines = enhanced ? parseStructuredWordLines(structured) : null;
      store({ ...parsed, wordLines, source: 'server', notFound: false });
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
        const parsed = result.syncedLyrics ? parseEnhancedLrc(result.syncedLyrics) : null;
        const synced = parsed?.lines.length ? parsed.lines : null;
        const wordLines = synced ? parsed?.wordLines ?? null : null;
        store({ syncedLines: synced, wordLines, plainLyrics: result.plainLyrics, source: 'lrclib', notFound: false });
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
      const persisted = await getCachedLyrics(cacheKey);
      if (cancelled) return;
      if (persisted) {
        // Don't re-write to L2 (it's already there); just hydrate RAM + UI.
        lyricsCache.set(cacheKey, persisted);
        applyEntry(persisted);
        return;
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
  }, [cacheKey, currentTrack?.id, lyricsSources, ownerServerId, ownerServerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { syncedLines, wordLines, plainLyrics, source, loading, notFound };
}
