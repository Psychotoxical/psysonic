import type { CoverArtHandle, CoverArtId, CoverServerScope, CoverSurfaceKind } from './types';

/** Phase A stub */
export function useCoverArt(
  _coverArtId: CoverArtId | null | undefined,
  _displayCssPx: number,
  _opts?: {
    serverScope?: CoverServerScope;
    surface?: CoverSurfaceKind;
    fullRes?: boolean;
    fetchQueueBias?: number;
    observeRootMargin?: string;
    alt?: string;
  },
): CoverArtHandle {
  return { src: '', storageKey: '', tier: 128, provisional: false };
}
