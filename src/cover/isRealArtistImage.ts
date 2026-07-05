/**
 * Filter out the well-known Last.fm "no image" placeholder that Subsonic
 * backends aggregate into `largeImageUrl`/`mediumImageUrl` when no real
 * artist image exists. The placeholder MD5 is fixed and documented.
 */
export function isRealArtistImage(url?: string): boolean {
  if (!url) return false;
  if (url.includes('2a96cbd8b46e442fc41c2b86b821562f')) return false;
  return true;
}
