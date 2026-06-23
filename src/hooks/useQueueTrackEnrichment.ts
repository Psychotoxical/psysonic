import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { libraryGetFacts, libraryGetTrack } from '../api/library';
import { usePlaybackServerId } from './usePlaybackServerId';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import {
  enrichmentDisplayComplete,
  OXIMEDIA_MOOD_UI_ENABLED,
  parseTrackEnrichmentFacts,
  type ParsedTrackEnrichment,
} from '../utils/library/trackEnrichment';
import { libraryIsReady } from '../utils/library/libraryReady';
import { normalizeAnalysisTrackId } from '../utils/playback/queueIdentity';

const EMPTY: ParsedTrackEnrichment = {
  serverBpm: null,
  measuredBpm: null,
  moodLabels: [],
};

/** Enrichment may finish several seconds after CPU seed / playback start. */
const REFETCH_MS = [3_000, 8_000, 15_000, 30_000, 60_000] as const;

const ENRICHMENT_FACT_KINDS = OXIMEDIA_MOOD_UI_ENABLED
  ? (['bpm', 'moods', 'mood_tag', 'mood_labels', 'valence', 'arousal'] as const)
  : (['bpm'] as const);

/**
 * Loads server BPM + oximedia mood facts for the queue "now playing" block.
 * Uses the playback server id (queue scope), not the browsed server.
 */
export function useQueueTrackEnrichment(trackId: string | undefined): ParsedTrackEnrichment {
  const serverId = usePlaybackServerId();
  const indexEnabled = useLibraryIndexStore(s =>
    serverId ? s.isIndexEnabled(serverId) : false,
  );
  const [data, setData] = useState<ParsedTrackEnrichment>(EMPTY);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!serverId || !trackId || !indexEnabled) {
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setData(EMPTY);
      return;
    }

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const load = async () => {
      if (!(await libraryIsReady(serverId))) return;
      try {
        const [track, facts] = await Promise.all([
          libraryGetTrack(serverId, trackId),
          libraryGetFacts(serverId, trackId, [...ENRICHMENT_FACT_KINDS]),
        ]);
        if (cancelled) return;
        const parsed = parseTrackEnrichmentFacts(facts, track?.bpm ?? null);
        setData(parsed);
        if (enrichmentDisplayComplete(parsed)) {
          for (const id of timers) clearTimeout(id);
          timers.length = 0;
        }
      } catch {
        if (!cancelled) setData(EMPTY);
      }
    };

    void load();
    for (const ms of REFETCH_MS) {
      timers.push(setTimeout(() => { void load(); }, ms));
    }

    return () => {
      cancelled = true;
      for (const id of timers) clearTimeout(id);
    };
  }, [serverId, trackId, indexEnabled, refreshNonce]);

  useEffect(() => {
    if (!serverId || !trackId || !indexEnabled) return;

    let unlisten: (() => void) | undefined;
    void listen<{ trackId: string; serverId: string }>('analysis:enrichment-updated', ({ payload }) => {
      if (!payload?.trackId) return;
      const eventTrackId = normalizeAnalysisTrackId(payload.trackId);
      const currentId = normalizeAnalysisTrackId(trackId);
      if (!eventTrackId || eventTrackId !== currentId) return;
      if (payload.serverId && payload.serverId !== serverId) return;
      setRefreshNonce(n => n + 1);
    }).then(fn => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [serverId, trackId, indexEnabled]);

  return data;
}
