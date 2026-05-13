import { useEffect, useState } from 'react';
import { getAlbum } from '../api/subsonicLibrary';
import { getArtist } from '../api/subsonicArtists';
import type { SubsonicAlbum } from '../api/subsonicTypes';

type AlbumPayload = Awaited<ReturnType<typeof getAlbum>>;

interface UseAlbumDetailDataResult {
  album: AlbumPayload | null;
  setAlbum: React.Dispatch<React.SetStateAction<AlbumPayload | null>>;
  relatedAlbums: SubsonicAlbum[];
  loading: boolean;
  isStarred: boolean;
  setIsStarred: (v: boolean) => void;
  starredSongs: Set<string>;
  setStarredSongs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/**
 * Load an album payload by id, then resolve the artist's other albums in
 * a follow-up call so the related-albums grid can render without blocking
 * the initial paint.
 *
 * On every id change we reset `relatedAlbums` to an empty array so the
 * grid doesn't briefly show the previous album's neighbours while the
 * new fetch is in flight. The two starred state pieces (`isStarred`,
 * `starredSongs`) are seeded from the response so optimistic toggles
 * have a baseline to revert to.
 */
export function useAlbumDetailData(id: string | undefined): UseAlbumDetailDataResult {
  const [album, setAlbum] = useState<AlbumPayload | null>(null);
  const [relatedAlbums, setRelatedAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [isStarred, setIsStarred] = useState(false);
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setRelatedAlbums([]);
    getAlbum(id).then(async data => {
      setAlbum(data);
      setIsStarred(!!data.album.starred);
      const initialStarred = new Set<string>();
      data.songs.forEach(s => { if (s.starred) initialStarred.add(s.id); });
      setStarredSongs(initialStarred);
      setLoading(false);
      try {
        const artistData = await getArtist(data.album.artistId);
        setRelatedAlbums(artistData.albums.filter(a => a.id !== id));
      } catch (e) {
        console.error('Failed to fetch related albums', e);
      }
    }).catch(() => setLoading(false));
  }, [id]);

  return { album, setAlbum, relatedAlbums, loading, isStarred, setIsStarred, starredSongs, setStarredSongs };
}
