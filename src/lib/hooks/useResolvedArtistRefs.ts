import { useEffect, useMemo, useState } from 'react';
import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';
import { peekArtistIdByName, resolveArtistIdsByName } from '@/lib/library/artistIdResolve';

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
 * first render with no flicker.
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

  // Bump on resolution so the memo below re-reads the cache. The cache itself holds
  // the values; this is only the render trigger.
  const [resolvedTick, setResolvedTick] = useState(0);

  useEffect(() => {
    if (!serverId || unresolved.length === 0) return;
    if (unresolved.every(name => peekArtistIdByName(serverId, name) !== undefined)) return;
    let cancelled = false;
    void resolveArtistIdsByName(serverId, unresolved).then(() => {
      if (!cancelled) setResolvedTick(tick => tick + 1);
    });
    return () => {
      cancelled = true;
    };
    // `namesKey` stands in for `unresolved`; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, namesKey]);

  return useMemo(() => {
    if (!serverId || unresolved.length === 0) return refs;
    return refs.map(ref => {
      if (ref.id || !ref.name?.trim()) return ref;
      const id = peekArtistIdByName(serverId, ref.name);
      return id ? { ...ref, id } : ref;
    });
    // `resolvedTick` is the signal that the cache changed underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, serverId, namesKey, resolvedTick]);
}
