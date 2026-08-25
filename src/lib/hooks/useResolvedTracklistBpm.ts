import { useEffect, useMemo, useState } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { libraryGetTracksBatchChunked, type TrackRefDto } from '@/lib/api/library';
import { libraryIsReady } from '@/lib/library/libraryReady';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';

function trackKey(serverId: string, trackId: string): string {
  return `${resolveIndexKey(serverId)}\u0000${trackId}`;
}

function ownerServerId(song: SubsonicSong, fallbackServerId?: string): string | null {
  return song.serverId?.trim() || fallbackServerId?.trim() || null;
}

/** Resolve locally analysed BPM in one batch, using the same precedence as Advanced Search. */
export function useResolvedTracklistBpm(
  songs: SubsonicSong[],
  enabled: boolean,
  fallbackServerId?: string,
): SubsonicSong[] {
  const [resolvedBpms, setResolvedBpms] = useState<Map<string, number>>(() => new Map());

  useEffect(() => {
    if (!enabled || songs.length === 0) return;
    let cancelled = false;

    const refsByKey = new Map<string, TrackRefDto>();
    for (const song of songs) {
      const serverId = ownerServerId(song, fallbackServerId);
      if (!serverId || !song.id) continue;
      refsByKey.set(trackKey(serverId, song.id), { serverId, trackId: song.id });
    }

    const load = async () => {
      const serverIds = [...new Set([...refsByKey.values()].map(ref => ref.serverId))];
      const readiness = await Promise.all(
        serverIds.map(async serverId => [serverId, await libraryIsReady(serverId)] as const),
      );
      const readyServers = new Set(readiness.filter(([, ready]) => ready).map(([serverId]) => serverId));
      const refs = [...refsByKey.values()].filter(ref => readyServers.has(ref.serverId));
      const tracks = await libraryGetTracksBatchChunked(refs);
      if (cancelled) return;

      const next = new Map<string, number>();
      for (const track of tracks) {
        if (track.bpm != null && track.bpm > 0) {
          next.set(trackKey(track.serverId, track.id), track.bpm);
        }
      }
      setResolvedBpms(next);
    };

    void load();
    return () => { cancelled = true; };
  }, [enabled, fallbackServerId, songs]);

  return useMemo(() => {
    if (!enabled || resolvedBpms.size === 0) return songs;
    let changed = false;
    const resolved = songs.map(song => {
      const serverId = ownerServerId(song, fallbackServerId);
      const bpm = serverId ? resolvedBpms.get(trackKey(serverId, song.id)) : undefined;
      if (bpm == null || bpm === song.bpm) return song;
      changed = true;
      return { ...song, bpm };
    });
    return changed ? resolved : songs;
  }, [enabled, fallbackServerId, resolvedBpms, songs]);
}
