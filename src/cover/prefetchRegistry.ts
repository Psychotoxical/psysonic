import type { CoverArtRef, CoverArtTier, CoverPrefetchPriority, CoverSurfaceKind } from './types';

export function coverPrefetchRegister(
  _refs: CoverArtRef[],
  _opts: {
    surface: CoverSurfaceKind;
    priority: CoverPrefetchPriority;
    deriveTiers?: CoverArtTier[];
  },
): () => void {
  return () => {};
}

export function coverCacheMayBackgroundDownload(): boolean {
  return true;
}
