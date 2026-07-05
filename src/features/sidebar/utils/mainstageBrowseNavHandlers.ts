import { albumsBrowseNavHandlers } from '@/features/album';
import { artistsBrowseNavHandlers } from '@/features/artist';

/** Sidebar / bottom-nav hover + click hooks for instrumented mainstage browse routes. */
export function mainstageBrowseNavHandlers(
  to: string,
  source: 'sidebar_click' | 'bottom_nav_click' = 'sidebar_click',
): {
  onMouseEnter?: () => void;
  onFocus?: () => void;
  onClick?: () => void;
} {
  const albums = albumsBrowseNavHandlers(to, source);
  const artists = artistsBrowseNavHandlers(to, source);
  return {
    onMouseEnter: () => {
      albums.onMouseEnter?.();
      artists.onMouseEnter?.();
    },
    onFocus: () => {
      albums.onFocus?.();
      artists.onFocus?.();
    },
    onClick: () => {
      albums.onClick?.();
      artists.onClick?.();
    },
  };
}
