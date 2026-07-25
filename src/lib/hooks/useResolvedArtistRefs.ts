import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';
import {
  getArtistIdResolveRevision,
  peekArtistIdByName,
  resolveArtistIdsByName,
  subscribeArtistIdResolve,
} from '@/lib/library/artistIdResolve';

/**
 * Fill in artist ids for credits that came from splitting a joined display string, so
 * every named artist is clickable and not just the primary one.
 *
 * Refs that already carry an id are returned untouched — the server's structured
 * `artists` list is always authoritative. Names with no artist row in the index stay
 * id-less and render as plain text.
 *
 * Resolution is cached process-wide, so the common case (every row of an album crediting
 * the same guest) costs a single lookup, and an already-cached name is applied on the
 * first render with no flicker. The hook follows the cache's revision rather than a
 * local tick: a row that mounted mid-request, a sync that added the missing artist, and
 * a retry after a transient backend failure all have to reach an already-mounted row.
 */
/**
 * @param serverId Owning server. Callers must apply the usual
 * `entity.serverId ?? activeServerId` fallback — `serverId` is only stamped on
 * owned/multi-server rows, and without the fallback the lookup would silently do
 * nothing on single-server, playlist and offline rows. Resolved by the caller rather
 * than here because `lib/**` must not read from `store/**`.
 */
export function useResolvedArtistRefs(
  refs: SubsonicOpenArtistRef[],
  serverId: string | null | undefined,
): SubsonicOpenArtistRef[] {
  const unresolved = useMemo(
    () => refs
      .filter(ref => !ref.id && !!ref.name?.trim())
      .map(ref => ref.name!.trim()),
    [refs],
  );
  // Stable dependency: the hook must re-resolve when the set of names changes, not
  // whenever the caller happens to rebuild the array. Serialised rather than joined
  // on a separator — artist names can contain any printable character, so a joined
  // key would make ["Miles Davis"] and ["Miles", "Davis"] indistinguishable and skip
  // the second one's lookup.
  const namesKey = JSON.stringify(unresolved);

  const revision = useSyncExternalStore(subscribeArtistIdResolve, getArtistIdResolveRevision);

  useEffect(() => {
    if (!serverId || unresolved.length === 0) return;
    if (unresolved.every(name => peekArtistIdByName(serverId, name) !== undefined)) return;
    void resolveArtistIdsByName(serverId, unresolved);
    // `namesKey` stands in for `unresolved`; `revision` re-runs this after an
    // invalidation or a scheduled retry, when names can become resolvable again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, namesKey, revision]);

  return useMemo(() => {
    if (!serverId || unresolved.length === 0) return refs;
    return refs.map(ref => {
      if (ref.id || !ref.name?.trim()) return ref;
      const id = peekArtistIdByName(serverId, ref.name);
      return id ? { ...ref, id } : ref;
    });
    // `revision` is the signal that the cache changed underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, serverId, namesKey, revision]);
}
