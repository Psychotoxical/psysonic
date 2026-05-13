import { useEffect, useState } from 'react';
import { getArtistInfo } from '../api/subsonicArtists';

/** Fetches the large artist image for the given artist id, returning '' until
 *  the request resolves (or when there is no artist id). Falls through silently
 *  on network failures — the caller should layer a cover-art fallback on top. */
export function useFsArtistPortrait(artistId: string | undefined): string {
  const [artistBgUrl, setArtistBgUrl] = useState<string>('');
  useEffect(() => {
    setArtistBgUrl('');
    if (!artistId) return;
    let cancelled = false;
    getArtistInfo(artistId).then(info => {
      if (!cancelled && info.largeImageUrl) setArtistBgUrl(info.largeImageUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [artistId]);
  return artistBgUrl;
}
