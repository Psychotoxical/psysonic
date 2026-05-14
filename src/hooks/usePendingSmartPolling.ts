import { useEffect } from 'react';
import type React from 'react';
import { getPlaylist } from '../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../api/subsonicTypes';
import { usePlaylistStore } from '../store/playlistStore';
import type { PendingSmartPlaylist } from '../utils/playlist/playlistsSmart';

/**
 * Poll Navidrome every 10 s for each pending smart playlist until its
 * rules finish processing on the server. We stop polling for an item when
 * (a) it has at least one song AND (b) its cover-art id has changed from
 * the placeholder we first saw — or after ~3 minutes as a fallback.
 *
 * Side-effects:
 *   - rehydrates the playlist store with fresh detail-endpoint metadata
 *     (cover, song count) as soon as it's available
 *   - shrinks `pendingSmart` as items finish
 */
export function usePendingSmartPolling(
  pendingSmart: PendingSmartPlaylist[],
  setPendingSmart: React.Dispatch<React.SetStateAction<PendingSmartPlaylist[]>>,
  fetchPlaylists: () => Promise<void>,
): void {
  useEffect(() => {
    if (pendingSmart.length === 0) return;
    const interval = window.setInterval(async () => {
      await fetchPlaylists();
      const listNow = usePlaylistStore.getState().playlists;
      const hydrated = pendingSmart.map(item => {
        if (item.id) return item;
        const found = listNow.find(p => p.name === item.name);
        return found ? { ...item, id: found.id } : item;
      });
      // Detail endpoint tends to reflect fresh metadata earlier than list endpoint.
      const ids = hydrated.map(p => p.id).filter((v): v is string => Boolean(v));
      const details = await Promise.all(
        ids.map(async (id) => {
          try {
            const { playlist } = await getPlaylist(id);
            return playlist;
          } catch {
            return null;
          }
        }),
      );
      const freshById = new Map(
        details.filter((p): p is SubsonicPlaylist => p !== null).map(p => [p.id, p]),
      );
      if (freshById.size > 0) {
        usePlaylistStore.setState((s) => ({
          playlists: s.playlists.map((p) => {
            const fresh = freshById.get(p.id);
            return fresh ? { ...p, ...fresh } : p;
          }),
        }));
      }
      const current = usePlaylistStore.getState().playlists;
      setPendingSmart(() => {
        const next: PendingSmartPlaylist[] = [];
        for (const item of hydrated) {
          const pl = item.id
            ? current.find(p => p.id === item.id)
            : current.find(p => p.name === item.name);
          if (!pl) {
            next.push({ ...item, attempts: item.attempts + 1 });
            continue;
          }
          const songCount = pl.songCount ?? 0;
          const currentCover = pl.coverArt;
          const firstCover = item.firstSeenCoverArt ?? currentCover;
          const placeholderStillThere = Boolean(firstCover) && currentCover === firstCover;
          // Wait until we see actual content and cover changed from the first placeholder-ish cover.
          // Fallback timeout keeps UI from waiting forever on servers that never update cover id.
          const hardTimeoutReached = item.attempts >= 18; // ~3 minutes (18 * 10s)
          const ready = songCount > 0 && (!placeholderStillThere || hardTimeoutReached);
          if (!ready) {
            next.push({
              ...item,
              id: pl.id,
              firstSeenCoverArt: firstCover,
              attempts: item.attempts + 1,
            });
          }
        }
        return next;
      });
    }, 10000);
    return () => window.clearInterval(interval);
  }, [pendingSmart, fetchPlaylists, setPendingSmart]);
}
