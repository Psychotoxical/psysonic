import { coverCacheEnsure } from '../../api/coverCache';
import { buildCoverArtFetchUrl } from '../fetchUrl';
import type { CoverArtRef } from '../types';

function fileUrlFromDiskPath(path: string): string {
  if (!path) return '';
  if (path.startsWith('file://')) return path;
  return `file://${path}`;
}

/** Discord large image — disk 800 path or HTTPS fetch URL. */
export async function coverArtUrlForDiscord(ref: CoverArtRef): Promise<string | null> {
  try {
    const result = await coverCacheEnsure(ref, 800);
    if (result.hit && result.path) {
      return fileUrlFromDiskPath(result.path);
    }
  } catch {
    /* fall through */
  }
  const url = buildCoverArtFetchUrl(ref, 800);
  return url || null;
}
