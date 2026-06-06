import { useCallback, useEffect, useState } from 'react';
import { queueSongStar } from '../store/pendingStarSync';
import type { SubsonicSong } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';
import {
  lastfmLoveTrack, lastfmUnloveTrack,
  type LastfmTrackInfo,
} from '../api/lastfm';

export interface NowPlayingStarLoveDeps {
  currentTrack: Pick<Track, 'id' | 'title' | 'artist' | 'serverId'> | null;
  songMeta: SubsonicSong | null;
  lfmTrack: LastfmTrackInfo | null;
  lfmLoveEnabled: boolean;
  lastfmSessionKey: string;
}

export interface NowPlayingStarLoveResult {
  starred: boolean;
  lfmLoved: boolean;
  toggleStar: () => Promise<void>;
  toggleLfmLove: () => Promise<void>;
}

export function useNowPlayingStarLove(deps: NowPlayingStarLoveDeps): NowPlayingStarLoveResult {
  const { currentTrack, songMeta, lfmTrack, lfmLoveEnabled, lastfmSessionKey } = deps;

  // Star
  const [starred, setStarred] = useState(false);
  useEffect(() => { setStarred(!!songMeta?.starred); }, [songMeta]);
  const toggleStar = useCallback(async () => {
    if (!currentTrack) return;
    const next = !starred;
    setStarred(next); // local view; helper owns the override + retried server sync (no rollback)
    queueSongStar(currentTrack.id, next, currentTrack.serverId);
  }, [currentTrack, starred]);

  // Last.fm love (seeded from track.getInfo, toggle via love/unlove)
  const [lfmLoved, setLfmLoved] = useState(false);
  useEffect(() => { setLfmLoved(!!lfmTrack?.userLoved); }, [lfmTrack]);
  const toggleLfmLove = useCallback(async () => {
    if (!currentTrack || !lfmLoveEnabled) return;
    const track = { title: currentTrack.title, artist: currentTrack.artist };
    if (lfmLoved) { await lastfmUnloveTrack(track, lastfmSessionKey); setLfmLoved(false); }
    else          { await lastfmLoveTrack  (track, lastfmSessionKey); setLfmLoved(true);  }
  }, [currentTrack, lfmLoved, lfmLoveEnabled, lastfmSessionKey]);

  return { starred, lfmLoved, toggleStar, toggleLfmLove };
}
