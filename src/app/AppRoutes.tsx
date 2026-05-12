import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import MobilePlayerView from '../components/MobilePlayerView';
import { useIsMobile } from '../hooks/useIsMobile';

// Route-level lazy loading: keeps the non-page graph (shell, player, stores) in
// the entry chunk; each page is fetched when its route is first visited.
const Home = lazy(() => import('../pages/Home'));
const Albums = lazy(() => import('../pages/Albums'));
const Artists = lazy(() => import('../pages/Artists'));
const ArtistDetail = lazy(() => import('../pages/ArtistDetail'));
const Composers = lazy(() => import('../pages/Composers'));
const ComposerDetail = lazy(() => import('../pages/ComposerDetail'));
const NewReleases = lazy(() => import('../pages/NewReleases'));
const Favorites = lazy(() => import('../pages/Favorites'));
const RandomMix = lazy(() => import('../pages/RandomMix'));
const RandomLanding = lazy(() => import('../pages/RandomLanding'));
const AlbumDetail = lazy(() => import('../pages/AlbumDetail'));
const MostPlayed = lazy(() => import('../pages/MostPlayed'));
const LosslessAlbums = lazy(() => import('../pages/LosslessAlbums'));
const RandomAlbums = lazy(() => import('../pages/RandomAlbums'));
const LuckyMixPage = lazy(() => import('../pages/LuckyMix'));
const SearchResults = lazy(() => import('../pages/SearchResults'));
const Playlists = lazy(() => import('../pages/Playlists'));
const PlaylistDetail = lazy(() => import('../pages/PlaylistDetail'));
const NowPlayingPage = lazy(() => import('../pages/NowPlaying'));
const Tracks = lazy(() => import('../pages/Tracks'));
const Settings = lazy(() => import('../pages/Settings'));
const Statistics = lazy(() => import('../pages/Statistics'));
const Help = lazy(() => import('../pages/Help'));
const WhatsNew = lazy(() => import('../pages/WhatsNew'));
const DeviceSync = lazy(() => import('../pages/DeviceSync'));
const OfflineLibrary = lazy(() => import('../pages/OfflineLibrary'));
const LabelAlbums = lazy(() => import('../pages/LabelAlbums'));
const AdvancedSearch = lazy(() => import('../pages/AdvancedSearch'));
const FolderBrowser = lazy(() => import('../pages/FolderBrowser'));
const InternetRadio = lazy(() => import('../pages/InternetRadio'));
const Genres = lazy(() => import('../pages/Genres'));
const GenreDetail = lazy(() => import('../pages/GenreDetail'));

/**
 * The main application route table. Rendered inside `AppShell`'s scroll
 * viewport. `/now-playing` swaps to the mobile player view on narrow widths;
 * `MobilePlayerView` is intentionally not lazy because the mobile breakpoint
 * is detected synchronously and the layout swap should be flicker-free.
 */
export default function AppRoutes() {
  const isMobile = useIsMobile();
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/albums" element={<Albums />} />
      <Route path="/tracks" element={<Tracks />} />
      <Route path="/random" element={<RandomLanding />} />
      <Route path="/random/albums" element={<RandomAlbums />} />
      <Route path="/album/:id" element={<AlbumDetail />} />
      <Route path="/artists" element={<Artists />} />
      <Route path="/artist/:id" element={<ArtistDetail />} />
      <Route path="/composers" element={<Composers />} />
      <Route path="/composer/:id" element={<ComposerDetail />} />
      <Route path="/new-releases" element={<NewReleases />} />
      <Route path="/favorites" element={<Favorites />} />
      <Route path="/random/mix" element={<RandomMix />} />
      <Route path="/lucky-mix" element={<LuckyMixPage />} />
      <Route path="/label/:name" element={<LabelAlbums />} />
      <Route path="/search" element={<SearchResults />} />
      <Route path="/search/advanced" element={<AdvancedSearch />} />
      <Route path="/statistics" element={<Statistics />} />
      <Route path="/most-played" element={<MostPlayed />} />
      <Route path="/lossless-albums" element={<LosslessAlbums />} />
      <Route path="/now-playing" element={isMobile ? <MobilePlayerView /> : <NowPlayingPage />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/whats-new" element={<WhatsNew />} />
      <Route path="/help" element={<Help />} />
      <Route path="/offline" element={<OfflineLibrary />} />
      <Route path="/genres" element={<Genres />} />
      <Route path="/genres/:name" element={<GenreDetail />} />
      <Route path="/playlists" element={<Playlists />} />
      <Route path="/playlists/:id" element={<PlaylistDetail />} />
      <Route path="/radio" element={<InternetRadio />} />
      <Route path="/folders" element={<FolderBrowser />} />
      <Route path="/device-sync" element={<DeviceSync />} />
    </Routes>
  );
}
