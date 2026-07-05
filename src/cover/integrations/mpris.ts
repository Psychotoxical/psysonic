import { coverCacheEnsure } from '@/lib/api/coverCache';
import { buildCoverArtFetchUrl } from '../fetchUrl';
import type { CoverArtRef } from '../types';

function fileUrlFromDiskPath(path: string): string {
  if (!path) return '';
  if (path.startsWith('file://')) return path;
  return `file://${path}`;
}

/** MPRIS cover — prefer on-disk 800.webp, else ephemeral HTTPS 800 URL. */
export async function coverArtUrlForMpris(ref: CoverArtRef): Promise<string> {
  try {
    const result = await coverCacheEnsure(ref, 800);
    if (result.hit && result.path) {
      return fileUrlFromDiskPath(result.path);
    }
  } catch {
    /* fall through to fetch URL */
  }
  return buildCoverArtFetchUrl(ref, 800);
}
