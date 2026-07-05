import type { ComponentType } from 'react';
import { emitArtistsBrowseNav, markArtistsBrowseNavIntent } from '@/lib/library/artistBrowseDebug';

type ArtistsPageModule = { default: ComponentType };

let chunkPromise: Promise<ArtistsPageModule> | null = null;

function loadArtistsPageModule(): Promise<ArtistsPageModule> {
  if (!chunkPromise) {
    emitArtistsBrowseNav('chunk_load_start');
    chunkPromise = import('@/features/artist/pages/Artists').then(mod => {
      emitArtistsBrowseNav('chunk_load_done');
      return mod;
    }).catch(err => {
      chunkPromise = null;
      emitArtistsBrowseNav('chunk_load_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
  }
  return chunkPromise;
}

/** Warm the `/artists` route chunk (sidebar hover / focus). */
export function prefetchArtistsPageChunk(): void {
  void loadArtistsPageModule();
}

export function lazyLoadArtistsPage(): Promise<ArtistsPageModule> {
  return loadArtistsPageModule();
}

export function artistsBrowseNavHandlers(
  to: string,
  source: 'sidebar_click' | 'bottom_nav_click' = 'sidebar_click',
): {
  onMouseEnter?: () => void;
  onFocus?: () => void;
  onClick?: () => void;
} {
  if (to !== '/artists') return {};
  return {
    onMouseEnter: prefetchArtistsPageChunk,
    onFocus: prefetchArtistsPageChunk,
    onClick: () => markArtistsBrowseNavIntent(source),
  };
}
