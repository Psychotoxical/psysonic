import { useCallback, useEffect, useState } from 'react';
import { queueSongStar } from '../store/pendingStarSync';
import type { SubsonicSong } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';
import type { TrackStats } from '../music-network';
import { getMusicNetworkRuntime } from '../music-network';

export interface NowPlayingStarLoveDeps {
  currentTrack: Pick<Track, 'id' | 'title' | 'artist' | 'serverId'> | null;
  songMeta: SubsonicSong | null;
  networkTrack: TrackStats | null;
  networkLoveEnabled: boolean;
}

export interface NowPlayingStarLoveResult {
  starred: boolean;
  networkLoved: boolean;
  toggleStar: () => Promise<void>;
  toggleNetworkLove: () => Promise<void>;
}

export function useNowPlayingStarLove(deps: NowPlayingStarLoveDeps): NowPlayingStarLoveResult {
  const { currentTrack, songMeta, networkTrack, networkLoveEnabled } = deps;

  // Star
  const [starred, setStarred] = useState(false);
  // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setStarred(!!songMeta?.starred); }, [songMeta]);
  const toggleStar = useCallback(async () => {
    if (!currentTrack) return;
    const next = !starred;
    setStarred(next); // local view; helper owns the override + retried server sync (no rollback)
    queueSongStar(currentTrack.id, next, currentTrack.serverId);
  }, [currentTrack, starred]);

  // Love (enrichment primary; seeded from track.getInfo, toggle via love/unlove)
  const [networkLoved, setNetworkLoved] = useState(false);
  // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setNetworkLoved(!!networkTrack?.userLoved); }, [networkTrack]);
  const toggleNetworkLove = useCallback(async () => {
    if (!currentTrack || !networkLoveEnabled) return;
    const track = { title: currentTrack.title, artist: currentTrack.artist };
    if (networkLoved) { await getMusicNetworkRuntime().setTrackLoved(track, false); setNetworkLoved(false); }
    else              { await getMusicNetworkRuntime().setTrackLoved(track, true);  setNetworkLoved(true);  }
  }, [currentTrack, networkLoved, networkLoveEnabled]);

  return { starred, networkLoved, toggleStar, toggleNetworkLove };
}
