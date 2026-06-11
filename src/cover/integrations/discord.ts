import { buildCoverArtFetchUrl } from '../fetchUrl';
import type { CoverArtRef } from '../types';

/**
 * Discord large image — always the HTTPS fetch URL, never a local cache path.
 * Discord Rich Presence images are fetched by Discord's own servers, so the
 * large_image must be a key or an https:// URL they can reach. A `file://` path
 * to the on-disk webp cache (what MPRIS uses) is meaningless to Discord and
 * silently falls back to the app icon — so we hand it the getCoverArt URL.
 */
export async function coverArtUrlForDiscord(ref: CoverArtRef): Promise<string | null> {
  return buildCoverArtFetchUrl(ref, 800) || null;
}
