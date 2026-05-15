/** Main scroll element wrapping `<Routes />` in App (overlay scrollbar). */
export const APP_MAIN_SCROLL_VIEWPORT_ID = 'app-main-scroll-viewport';

/** In-page list/grid viewports when the main route scroll is locked (see AppShell). */
export const ARTISTS_INPAGE_SCROLL_VIEWPORT_ID = 'artists-inpage-scroll-viewport';
export const ALBUMS_INPAGE_SCROLL_VIEWPORT_ID = 'albums-inpage-scroll-viewport';
export const NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID = 'new-releases-inpage-scroll-viewport';
export const LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID = 'lossless-albums-inpage-scroll-viewport';
export const COMPOSERS_INPAGE_SCROLL_VIEWPORT_ID = 'composers-inpage-scroll-viewport';

/** Route pathname → in-page overlay viewport id (must match `viewportId` on each page). */
export const MAIN_ROUTE_INPAGE_SCROLL_VIEWPORT_ID_BY_PATH: Readonly<Record<string, string>> = {
  '/artists': ARTISTS_INPAGE_SCROLL_VIEWPORT_ID,
  '/albums': ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
  '/new-releases': NEW_RELEASES_INPAGE_SCROLL_VIEWPORT_ID,
  '/lossless-albums': LOSSLESS_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
  '/composers': COMPOSERS_INPAGE_SCROLL_VIEWPORT_ID,
};
