import type { ComponentType } from 'react';
import { emitAlbumBrowseNav, markAlbumBrowseNavIntent } from '@/lib/library/albumBrowseDebug';

type AlbumsPageModule = { default: ComponentType };

let chunkPromise: Promise<AlbumsPageModule> | null = null;

function loadAlbumsPageModule(): Promise<AlbumsPageModule> {
  if (!chunkPromise) {
    emitAlbumBrowseNav('chunk_load_start');
    chunkPromise = import('@/features/album/pages/Albums').then(mod => {
      emitAlbumBrowseNav('chunk_load_done');
      return mod;
    }).catch(err => {
      chunkPromise = null;
      emitAlbumBrowseNav('chunk_load_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
  }
  return chunkPromise;
}

/** Warm the `/albums` route chunk (sidebar hover / focus). */
export function prefetchAlbumsPageChunk(): void {
  void loadAlbumsPageModule();
}

export function lazyLoadAlbumsPage(): Promise<AlbumsPageModule> {
  return loadAlbumsPageModule();
}

export function albumsBrowseNavHandlers(
  to: string,
  source: 'sidebar_click' | 'bottom_nav_click' = 'sidebar_click',
): {
  onMouseEnter?: () => void;
  onFocus?: () => void;
  onClick?: () => void;
} {
  if (to !== '/albums') return {};
  return {
    onMouseEnter: prefetchAlbumsPageChunk,
    onFocus: prefetchAlbumsPageChunk,
    onClick: () => markAlbumBrowseNavIntent(source),
  };
}
