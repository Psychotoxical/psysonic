import { useEffect, useState } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { LibraryScopePair } from '@/lib/api/library/scopeReads';
import { tryLoadArtistDetailMultiScope } from '@/lib/library/loadArtistDetailMultiScope';
import { isLosslessSuffix } from '@/lib/library/losslessFormats';

export interface ArtistAllTracksState {
  tracks: SubsonicSong[];
  loading: boolean;
  /** The index could not answer — the tab shows an empty state instead of a spinner. */
  failed: boolean;
}

interface Params {
  scopes: LibraryScopePair[];
  serverId: string;
  artistId: string;
  /** Turns true when the user opens the tab; the fetch never runs before that. */
  enabled: boolean;
  /**
   * Lossless browsing mode. The index query has no lossless filter, so the list
   * is narrowed here — otherwise the tab next to one labelled "Lossless" would
   * offer lossy tracks, and playing one would queue exactly what the mode hides.
   */
  losslessOnly?: boolean;
}

/**
 * Restores the order the backend returned the tracks in.
 *
 * `tryLoadArtistDetailMultiScope` re-sorts by play count on the way out, because
 * its other callers want a popularity ranking of five. Without a limit the query
 * already orders by album, then track number, then title — which is the order a
 * full discography should read in — so that ordering is rebuilt here rather than
 * changing a loader three other pages depend on.
 */
function byAlbumOrder(songs: SubsonicSong[]): SubsonicSong[] {
  const text = (value: string | undefined) => value ?? '';
  return [...songs].sort((a, b) => {
    const album = text(a.album).localeCompare(text(b.album), undefined, { sensitivity: 'base' });
    if (album !== 0) return album;
    // Disc before track: on a double album both discs restart at track 1, so
    // comparing track numbers alone interleaves the two records.
    const aDisc = a.discNumber ?? 1;
    const bDisc = b.discNumber ?? 1;
    if (aDisc !== bDisc) return aDisc - bDisc;
    // Absent track numbers sort last, matching the query's `NULLS LAST`.
    const aTrack = a.track ?? Number.MAX_SAFE_INTEGER;
    const bTrack = b.track ?? Number.MAX_SAFE_INTEGER;
    if (aTrack !== bTrack) return aTrack - bTrack;
    return text(a.title).localeCompare(text(b.title), undefined, { sensitivity: 'base' });
  });
}

/**
 * Every track the artist performs on, loaded the first time the tab is opened.
 *
 * The same index call the page already makes for its Top Tracks answers this —
 * passing no limit swaps the backend's `ORDER BY play_count … LIMIT` for an
 * album/track-number ordering over the full set, so no second query path and no
 * network call are involved.
 *
 * Deliberately lazy: the artist page itself loads five ranked tracks, which is
 * cheap. Pulling a full discography on every page view would make visitors who
 * never open the tab pay for it.
 */
export function useArtistAllTracks({
  scopes, serverId, artistId, enabled, losslessOnly = false,
}: Params): ArtistAllTracksState {
  /**
   * Result and failure each carry the identity they belong to, instead of living
   * in separate states that can drift apart from it. That keeps three cases
   * honest at once: another artist shows nothing rather than the previous one's
   * tracks; returning to an artist that already loaded shows it again without
   * refetching; and a failure on one artist cannot strand another that was fine.
   */
  const [loaded, setLoaded] = useState<{ identity: string; songs: SubsonicSong[] } | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);

  // Closing the tab drops a failure so reopening retries, rather than leaving the
  // error up until the user navigates elsewhere. Adjusted during render instead of
  // in an effect, which would cost an extra render pass.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled && failedFor !== null) setFailedFor(null);
  }

  const scopeKey = scopes.map(pair => `${pair.serverId}\u0000${pair.libraryId ?? ''}`).join('\u0001');
  const identity = `${serverId}\u0000${artistId}\u0000${scopeKey}`;

  // Lossless mode narrows the same query's result, so it belongs in the key —
  // otherwise switching modes would keep showing the previously filtered list.
  const cacheKey = `${identity}|${losslessOnly ? 'lossless' : 'all'}`;

  const isCurrent = loaded != null && loaded.identity === cacheKey;
  const failed = failedFor === cacheKey;
  const canLoad = enabled && !!serverId && !!artistId && scopes.length > 0;
  const shouldLoad = canLoad && !isCurrent && !failed;

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    // `null` = no top-tracks limit, which is what turns this into the full list.
    void tryLoadArtistDetailMultiScope(scopes, serverId, artistId, null)
      .then(result => {
        if (cancelled) return;
        if (!result) { setFailedFor(cacheKey); return; }
        const songs = losslessOnly
          ? result.topSongs.filter(song => isLosslessSuffix(song.suffix))
          : result.topSongs;
        setLoaded({ identity: cacheKey, songs: byAlbumOrder(songs) });
      });
    return () => { cancelled = true; };
    // `cacheKey` folds artist, server, scope and lossless mode into one dependency;
    // `scopes` is a fresh array each render and would restart the load on every
    // parent update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoad, cacheKey]);

  return {
    tracks: isCurrent ? loaded.songs : [],
    // Derived rather than stored, so the first frame after opening the tab already
    // reads as loading instead of flashing "nothing found" before the effect runs.
    loading: canLoad && !isCurrent && !failed,
    failed,
  };
}
