import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

// Keep pagination termination rules aligned with the hook implementation.
function resolveHasMoreAfterPage(
  page: { albums: SubsonicAlbum[]; hasMore: boolean },
  append: boolean,
  prevCount: number,
  mergedCount: number,
): boolean {
  if (page.albums.length === 0) return false;
  if (append && mergedCount === prevCount) return false;
  return page.hasMore;
}

describe('resolveHasMoreAfterPage', () => {
  it('stops when the server returns an empty page', () => {
    expect(resolveHasMoreAfterPage({ albums: [], hasMore: true }, true, 30, 30)).toBe(false);
  });

  it('stops when dedupe adds no new albums', () => {
    expect(resolveHasMoreAfterPage({ albums: [{ id: 'a1' } as SubsonicAlbum], hasMore: true }, true, 1, 1)).toBe(false);
  });

  it('continues while the page grows and the server reports more', () => {
    expect(resolveHasMoreAfterPage({ albums: [{ id: 'a2' } as SubsonicAlbum], hasMore: true }, true, 1, 2)).toBe(true);
  });
});
