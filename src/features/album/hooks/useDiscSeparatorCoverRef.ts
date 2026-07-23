import { useMemo } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { type CoverArtRef, coverScopeKey } from '@/cover/types';
import { albumCoverRefForSong } from '@/cover/ref';
import { songHasDiscSpecificCover } from '@/cover/resolveEntry';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import { useServerUnavailable } from '@/lib/network/serverReachability';

export type DiscSeparatorSong = Pick<
  SubsonicSong,
  'id' | 'albumId' | 'coverArt' | 'discNumber' | 'serverId'
>;

/**
 * Cover ref for a multi-disc separator, with a graceful offline fallback.
 *
 * A disc with genuine per-track/per-disc art (`mf-*`/`dc-*`) resolves to its own
 * cache slot so different discs don't collide on the first disc's cover. That slot
 * may be cold, and `useCoverArt` will not fetch a missing slot while the owning
 * server is unreachable, leaving the separator blank even though the album hero has
 * already warmed the shared album cover. So while the server is known-unreachable,
 * fall back to the album-scoped ref, which reuses that shared cover; once the server
 * is reachable again the disc-specific ref wins.
 *
 * Reachability comes from the probe-based reachability store, not `navigator.onLine`
 * (WebKitGTK inside Tauri leaves `navigator.onLine === false` even when the server is
 * reachable, so the navigator hint is inert on desktop). `useServerUnavailable` is a
 * per-server boolean snapshot, so a reconnect re-renders this separator (and upgrades
 * it to the disc-specific cover live) without waking every disc header on unrelated
 * servers' probes.
 *
 * Tracks with no usable disc-specific cover already resolve album-scoped, so there is
 * nothing to fall back to.
 */
export function useDiscSeparatorCoverRef(song: DiscSeparatorSong): CoverArtRef | undefined {
  const serverUnreachable = useServerUnavailable(song.serverId);

  const scope = coverServerScopeForServerId(song.serverId);
  const distinct = songHasDiscSpecificCover(song);
  const discRef = albumCoverRefForSong(song, distinct, scope);

  // Build the album-scoped fallback only when it will actually be used (a distinct
  // disc slot on an unreachable server); otherwise the disc ref is the answer.
  const chosen =
    distinct && serverUnreachable && discRef
      ? albumCoverRefForSong(song, false, scope) ?? discRef
      : discRef;

  // CoverArtImage rebuilds its IntersectionObserver whenever the `coverRef` object
  // identity changes, and `albumCoverRefForSong` returns a fresh object each call, so
  // hold a stable identity keyed on the fields that matter. `coverScopeKey` is the
  // same server-scope key the rest of the cover system uses (keyed by server id).
  const scopeKey = coverScopeKey(scope);
  return useMemo(
    () => chosen,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosen?.cacheKind, chosen?.cacheEntityId, chosen?.fetchCoverArtId, scopeKey],
  );
}
