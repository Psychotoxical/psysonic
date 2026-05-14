import { useCallback } from 'react';
import { setRating } from '../api/subsonicStarRating';
import type { SubsonicAlbum, SubsonicArtist } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';
import { useAuthStore } from '../store/authStore';
import { showToast } from '../utils/ui/toast';

type RatingKind = 'song' | 'album' | 'artist';

interface Args {
  type: string | null;
  item: unknown;
  userRatingOverrides: Record<string, number>;
  setUserRatingOverride: (id: string, rating: number) => void;
  entityRatingSupport: 'full' | 'track_only' | 'unknown';
  t: (key: string) => string;
}

interface Result {
  applySongRating: (songId: string, rating: number) => void;
  applyAlbumRating: (album: SubsonicAlbum, rating: number) => void;
  applyArtistRating: (artist: SubsonicArtist, rating: number) => void;
  getRatingValueByKind: (kind: RatingKind, id: string) => number;
  commitRatingByKind: (kind: RatingKind, id: string, rating: number) => void;
}

export function useContextMenuRating({
  type, item, userRatingOverrides, setUserRatingOverride, entityRatingSupport, t,
}: Args): Result {
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const activeServerId = useAuthStore(s => s.activeServerId);

  const applySongRating = useCallback((songId: string, rating: number) => {
    setUserRatingOverride(songId, rating);
    setRating(songId, rating).catch(() => {});
  }, [setUserRatingOverride]);

  const applyAlbumRating = useCallback((album: SubsonicAlbum, rating: number) => {
    setUserRatingOverride(album.id, rating);
    if (entityRatingSupport !== 'full') return;
    setRating(album.id, rating).catch(err => {
      if (activeServerId) setEntityRatingSupport(activeServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    });
  }, [setUserRatingOverride, entityRatingSupport, activeServerId, setEntityRatingSupport, t]);

  const applyArtistRating = useCallback((artist: SubsonicArtist, rating: number) => {
    setUserRatingOverride(artist.id, rating);
    if (entityRatingSupport !== 'full') return;
    setRating(artist.id, rating).catch(err => {
      if (activeServerId) setEntityRatingSupport(activeServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    });
  }, [setUserRatingOverride, entityRatingSupport, activeServerId, setEntityRatingSupport, t]);

  const getRatingValueByKind = useCallback((kind: RatingKind, id: string): number => {
    if (kind === 'song' && (type === 'song' || type === 'album-song' || type === 'queue-item')) {
      const song = item as Track;
      if (song.id === id) return userRatingOverrides[id] ?? song.userRating ?? 0;
    }
    if (kind === 'album' && type === 'album') {
      const album = item as SubsonicAlbum;
      if (album.id === id) return userRatingOverrides[id] ?? album.userRating ?? 0;
    }
    if (kind === 'album' && type === 'multi-album') {
      const albums = item as SubsonicAlbum[];
      const compositeId = [...albums.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return userRatingOverrides[id] ?? 0;
      if (albums.length === 0) return 0;
      const vals = albums.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
      const first = vals[0];
      return vals.every(v => v === first) ? first : 0;
    }
    if (kind === 'artist' && type === 'artist') {
      const artist = item as SubsonicArtist;
      if (artist.id === id) return userRatingOverrides[id] ?? artist.userRating ?? 0;
    }
    if (kind === 'artist' && type === 'multi-artist') {
      const artists = item as SubsonicArtist[];
      const compositeId = [...artists.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return userRatingOverrides[id] ?? 0;
      if (artists.length === 0) return 0;
      const vals = artists.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
      const first = vals[0];
      return vals.every(v => v === first) ? first : 0;
    }
    return userRatingOverrides[id] ?? 0;
  }, [type, item, userRatingOverrides]);

  const commitRatingByKind = useCallback((kind: RatingKind, id: string, rating: number) => {
    if (kind === 'song') {
      applySongRating(id, rating);
      return;
    }
    if (kind === 'album' && type === 'album') {
      applyAlbumRating(item as SubsonicAlbum, rating);
      return;
    }
    if (kind === 'album' && type === 'multi-album') {
      const albums = item as SubsonicAlbum[];
      const compositeId = [...albums.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return;
      for (const a of albums) applyAlbumRating(a, rating);
      return;
    }
    if (kind === 'artist' && type === 'artist') {
      applyArtistRating(item as SubsonicArtist, rating);
      return;
    }
    if (kind === 'artist' && type === 'multi-artist') {
      const artists = item as SubsonicArtist[];
      const compositeId = [...artists.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return;
      for (const a of artists) applyArtistRating(a, rating);
    }
  }, [applySongRating, applyAlbumRating, applyArtistRating, type, item]);

  return { applySongRating, applyAlbumRating, applyArtistRating, getRatingValueByKind, commitRatingByKind };
}
