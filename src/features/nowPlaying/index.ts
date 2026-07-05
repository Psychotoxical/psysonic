/**
 * Now Playing feature — the Now Playing page (album/artist/credits/discography/
 * tour cards, hero), its layout store and index-first metadata resolvers, the
 * topbar "Who is listening?" dropdown, and the queue-side track info panel.
 *
 * The page itself is lazy-loaded via the deep path `pages/NowPlaying`.
 * `ArtistCard` is also reused by the Artist Detail page.
 */
export { default as NowPlayingDropdown } from './components/NowPlayingDropdown';
export { default as NowPlayingInfo } from './components/NowPlayingInfo';
export { default as ArtistCard } from './components/ArtistCard';
export { useNowPlayingPrewarm } from './hooks/useNowPlayingPrewarm';
