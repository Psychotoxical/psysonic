/** Main scroll element wrapping `<Routes />` in App (overlay scrollbar). */
export const APP_MAIN_SCROLL_VIEWPORT_ID = 'app-main-scroll-viewport';

/** In-page list/grid viewports when the main route scroll is locked (see AppShell). */
export const ARTISTS_INPAGE_SCROLL_VIEWPORT_ID = 'artists-inpage-scroll-viewport';
export const ALBUMS_INPAGE_SCROLL_VIEWPORT_ID = 'albums-inpage-scroll-viewport';
export const NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID = 'new-releases-inpage-scroll-viewport';
export const RANDOM_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID = 'random-albums-inpage-scroll-viewport';
export const LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID = 'lossless-albums-inpage-scroll-viewport';
export const COMPOSERS_INPAGE_SCROLL_VIEWPORT_ID = 'composers-inpage-scroll-viewport';

export type AlbumGridInpageScrollSurface = 'albums' | 'new-releases' | 'random-albums';

/** Route pathname → in-page overlay viewport id (must match `viewportId` on each page). */
export const MAIN_ROUTE_INPAGE_SCROLL_VIEWPORT_ID_BY_PATH: Readonly<Record<string, string>> = {
  '/artists': ARTISTS_INPAGE_SCROLL_VIEWPORT_ID,
  '/albums': ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
  '/new-releases': NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID,
  '/random/albums': RANDOM_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
  '/lossless-albums': LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
  '/composers': COMPOSERS_INPAGE_SCROLL_VIEWPORT_ID,
};

const INPAGE_VIEWPORT_ID_BY_SURFACE: Record<AlbumGridInpageScrollSurface, string> = {
  albums: ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
  'new-releases': NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID,
  'random-albums': RANDOM_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
};

export function inpageScrollViewportIdForSurface(surface: AlbumGridInpageScrollSurface): string {
  return INPAGE_VIEWPORT_ID_BY_SURFACE[surface];
}

/** Read live in-page scroll offset (prefer over render-time refs when leaving for album detail). */
export function readInpageScrollTop(viewportId: string): number {
  return document.getElementById(viewportId)?.scrollTop ?? 0;
}

/** Resolve in-page viewport id for the current route pathname. */
export function mainRouteInpageScrollViewportId(pathname: string): string | undefined {
  const path = pathname.split('?')[0]?.replace(/\/$/, '') || pathname;
  return MAIN_ROUTE_INPAGE_SCROLL_VIEWPORT_ID_BY_PATH[path];
}
