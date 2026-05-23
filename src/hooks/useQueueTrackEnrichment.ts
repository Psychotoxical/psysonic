import { useEffect, useState } from 'react';
import { libraryGetFacts, libraryGetTrack } from '../api/library';
import { usePlaybackServerId } from './usePlaybackServerId';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import {
  enrichmentHasMoodLabels,
  parseTrackEnrichmentFacts,
  type ParsedTrackEnrichment,
} from '../utils/library/trackEnrichment';
import { libraryIsReady } from '../utils/library/libraryReady';

const EMPTY: ParsedTrackEnrichment = {
  serverBpm: null,
  measuredBpm: null,
  moodLabels: [],
};

/** Enrichment may finish several seconds after CPU seed / playback start. */
const REFETCH_MS = [3_000, 8_000, 15_000, 30_000] as const;

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

  useEffect(() => {
    if (!serverId || !trackId || !indexEnabled) {
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
          libraryGetFacts(serverId, trackId, ['bpm', 'moods', 'mood_labels', 'valence', 'arousal']),
        ]);
        if (cancelled) return;
        const parsed = parseTrackEnrichmentFacts(facts, track?.bpm ?? null);
        setData(parsed);
        if (enrichmentHasMoodLabels(parsed)) {
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
  }, [serverId, trackId, indexEnabled]);

  return data;
}
