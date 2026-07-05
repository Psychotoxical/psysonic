/**
 * Home (Mainstage) feature — the Home landing page, its Hero banner, the song
 * rail + "because you like" recommendation rail, the mainstage section config
 * store, and the home-feed / because-you-like client caches. The page is
 * lazy-loaded by the router via its deep path, so it is not re-exported here.
 *
 * Cross-feature consumers pull only the section config store (settings'
 * mainstage customiser, the tracks-page chrome).
 */
export { useHomeStore, type HomeSectionId, type HomeSectionConfig, DEFAULT_HOME_SECTIONS } from './store/homeStore';
export { default as SongRail } from './components/SongRail';
