import { useEffect, useState } from 'react';
import { filterSongsToServerLibrary } from '@/lib/api/subsonicLibrary';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { isSmartPlaylistName } from '@/features/playlist';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';

/**
 * Build the 2×2 cover collage for each smart playlist. Pulls each smart
 * playlist's tracks (filtered to the active library scope) and collects up
 * to four unique cover-art IDs. Re-runs when the playlist list changes or
 * when the active library filter version bumps.
 */
export function useSmartCoverCollage(
  playlists: SubsonicPlaylist[],
  musicLibraryFilterVersion: number,
): Record<string, string[]> {
  const [smartCoverIdsByPlaylist, setSmartCoverIdsByPlaylist] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const smart = playlists.filter(pl => isSmartPlaylistName(pl.name));
      if (smart.length === 0) {
        if (!cancelled) setSmartCoverIdsByPlaylist({});
        return;
      }
      const rows = await Promise.all(
        smart.map(async (pl) => {
          try {
            if (!pl.serverId) throw new Error('Playlist owner unavailable');
            const { songs } = await getPlaylistForServer(pl.serverId, pl.id);
            const filtered = await filterSongsToServerLibrary(songs, pl.serverId);
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const s of filtered) {
              const cid = s.coverArt;
              if (!cid || seen.has(cid)) continue;
              seen.add(cid);
              ids.push(cid);
              if (ids.length >= 4) break;
            }
            return [libraryEntityKey(pl), ids] as const;
          } catch {
            return [libraryEntityKey(pl), [] as string[]] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, string[]> = {};
      for (const [id, ids] of rows) next[id] = ids;
      setSmartCoverIdsByPlaylist(next);
    };
    run();
    return () => { cancelled = true; };
  }, [playlists, musicLibraryFilterVersion]);

  return smartCoverIdsByPlaylist;
}
