import { useCallback, useEffect, useState } from 'react';
import { star, unstar } from '../api/subsonicStarRating';
import type { SubsonicSong } from '../api/subsonicTypes';
import {
  lastfmLoveTrack, lastfmUnloveTrack,
  type LastfmTrackInfo,
} from '../api/lastfm';

export interface NowPlayingStarLoveDeps {
  currentTrack: { id: string; title: string; artist: string } | null;
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
    if (starred) { await unstar(currentTrack.id, 'song'); setStarred(false); }
    else         { await star(currentTrack.id,   'song'); setStarred(true);  }
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
