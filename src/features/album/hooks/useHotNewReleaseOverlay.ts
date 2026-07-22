import { useEffect, useState } from 'react';
import type { LibraryScopePair } from '@/lib/api/library/scopeReads';
import {
  fetchHotNewReleases,
  type ResolvedHotNewRelease,
} from '@/features/album/utils/hotNewReleases';
import {
  describeMultiServerError,
  emitMultiServerDebug,
} from '@/lib/library/multiServerDebug';

/** Network-only first-page overlay; stale results are discarded when scope changes. */
export function useHotNewReleaseOverlay(
  scopes: LibraryScopePair[],
  scopeFingerprint: string,
  active: boolean,
): { scopeFingerprint: string; albums: ResolvedHotNewRelease[] } {
  const [result, setResult] = useState({
    scopeFingerprint: '',
    albums: [] as ResolvedHotNewRelease[],
  });

  useEffect(() => {
    let cancelled = false;
    if (!active || scopes.length === 0) {
      emitMultiServerDebug('new_releases_hot_overlay_skip', {
        reason: !active ? 'inactive' : 'empty_scope',
        active,
        scopes,
        scopeFingerprint,
      });
      return () => { cancelled = true; };
    }
    const startedAt = performance.now();
    emitMultiServerDebug('new_releases_hot_overlay_start', { scopes, scopeFingerprint });
    void fetchHotNewReleases(scopes)
      .then(result => {
        emitMultiServerDebug('new_releases_hot_overlay_done', {
          scopes,
          scopeFingerprint,
          cancelled,
          durationMs: Math.round(performance.now() - startedAt),
          albumCount: result.length,
          sampleAlbums: result.slice(0, 10).map(resolved => ({
            serverId: resolved.album.serverId,
            id: resolved.album.id,
            name: resolved.album.name,
            representativeServerId: resolved.representativeServerId ?? null,
            representativeId: resolved.representativeId ?? null,
            group: resolved.group,
          })),
        });
        if (!cancelled) setResult({ scopeFingerprint, albums: result });
      })
      .catch(error => emitMultiServerDebug('new_releases_hot_overlay_error', {
        scopes,
        scopeFingerprint,
        cancelled,
        durationMs: Math.round(performance.now() - startedAt),
        error: describeMultiServerError(error),
      }));
    return () => {
      cancelled = true;
      emitMultiServerDebug('new_releases_hot_overlay_cleanup', { scopes, scopeFingerprint });
    };
  }, [active, scopeFingerprint, scopes]);

  return result;
}
