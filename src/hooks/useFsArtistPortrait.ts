import { useEffect, useState } from 'react';
import { getArtistInfo } from '../api/subsonicArtists';

/** Fetches the large artist image for the given artist id, returning '' until
 *  the request resolves (or when there is no artist id). Falls through silently
 *  on network failures — the caller should layer a cover-art fallback on top.
 *
 *  Navidrome / Subsonic backends often return a `largeImageUrl` that 404s when
 *  the artist has no scraped image (Last.fm placeholder), so the URL is
 *  preflighted via an Image() probe and only exposed when it actually loads.
 *  Otherwise the caller would render a broken-img glyph (`?`) on top of the
 *  fullscreen background — see zunoz report on the Psysonic Discord. */
export function useFsArtistPortrait(artistId: string | undefined): string {
  const [artistBgUrl, setArtistBgUrl] = useState<string>('');
  useEffect(() => {
    setArtistBgUrl('');
    if (!artistId) return;
    let cancelled = false;
    let probe: HTMLImageElement | null = null;
    getArtistInfo(artistId).then(info => {
      if (cancelled || !info.largeImageUrl) return;
      const url = info.largeImageUrl;
      probe = new Image();
      probe.onload = () => { if (!cancelled) setArtistBgUrl(url); };
      probe.onerror = () => { /* leave empty so caller falls back to cover */ };
      probe.src = url;
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (probe) probe.onload = probe.onerror = null;
    };
  }, [artistId]);
  return artistBgUrl;
}
