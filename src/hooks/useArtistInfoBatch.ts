import { useEffect, useMemo, useState } from 'react';
import { getArtistInfoForServer } from '../api/subsonicArtists';
import type { SubsonicArtistInfo, SubsonicOpenArtistRef } from '../api/subsonicTypes';
import { makeCache } from '../utils/cache/nowPlayingCache';

const artistInfoCache = makeCache<SubsonicArtistInfo | null>();

function cacheKey(serverId: string, artistId: string): string {
  return `${serverId}:${artistId}`;
}

/**
 * Fetches `getArtistInfo` for each ref with an id. Returns `undefined` for ids
 * still loading, `null` when fetch finished with no info.
 */
export function useArtistInfoBatch(
  serverId: string | undefined,
  refs: SubsonicOpenArtistRef[],
  similarArtistCount?: number,
): Record<string, SubsonicArtistInfo | null | undefined> {
  const ids = useMemo(
    () => [...new Set(refs.map(r => r.id?.trim()).filter((id): id is string => Boolean(id)))],
    [refs],
  );
  const idsKey = ids.join('\x1e');

  const [byId, setById] = useState<Record<string, SubsonicArtistInfo | null | undefined>>(() => {
    if (!serverId || ids.length === 0) return {};
    const seed: Record<string, SubsonicArtistInfo | null | undefined> = {};
    for (const id of ids) {
      const cached = artistInfoCache.get(cacheKey(serverId, id));
      if (cached !== undefined) seed[id] = cached;
    }
    return seed;
  });

  useEffect(() => {
    if (!serverId || ids.length === 0) {
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setById({});
      return;
    }

    const next: Record<string, SubsonicArtistInfo | null | undefined> = {};
    const pending: string[] = [];
    for (const id of ids) {
      const cached = artistInfoCache.get(cacheKey(serverId, id));
      if (cached !== undefined) {
        next[id] = cached;
      } else {
        next[id] = undefined;
        pending.push(id);
      }
    }
    setById(next);

    if (pending.length === 0) return;

    let cancelled = false;
    void Promise.all(
      pending.map(async id => {
        try {
          const info = await getArtistInfoForServer(serverId, id, {
            similarArtistCount: similarArtistCount,
          });
          artistInfoCache.set(cacheKey(serverId, id), info ?? null);
          return [id, info ?? null] as const;
        } catch {
          artistInfoCache.set(cacheKey(serverId, id), null);
          return [id, null] as const;
        }
      }),
    ).then(results => {
      if (cancelled) return;
      setById(prev => {
        const merged = { ...prev };
        for (const [id, info] of results) merged[id] = info;
        return merged;
      });
    });

    return () => { cancelled = true; };
    // Keyed on idsKey (the stable string form of `ids`); depending on the ids
    // array directly would re-fetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, idsKey, similarArtistCount]);

  return byId;
}
