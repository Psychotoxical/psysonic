import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import MobilePlayerView from '@/features/nowPlaying/components/MobilePlayerView';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useSidebarStore } from '@/features/sidebar';
import { useAuthStore } from '../store/authStore';
import { useLuckyMixAvailable } from '@/features/randomMix';
import { resolveStartRoute } from '@/features/sidebar';

// Route-level lazy loading: keeps the non-page graph (shell, player, stores) in
// the entry chunk; each page is fetched when its route is first visited.
const Home = lazy(() => import('@/features/home/pages/Home'));
const Albums = lazy(() => import('@/features/album/pages/Albums'));
const Artists = lazy(() => import('@/features/artist/pages/Artists'));
const ArtistDetail = lazy(() => import('@/features/artist/pages/ArtistDetail'));
const Composers = lazy(() => import('@/features/composers/pages/Composers'));
const ComposerDetail = lazy(() => import('@/features/composers/pages/ComposerDetail'));
const NewReleases = lazy(() => import('@/features/album/pages/NewReleases'));
const Favorites = lazy(() => import('@/features/favorites/pages/Favorites'));
const RandomMix = lazy(() => import('@/features/randomMix/pages/RandomMix'));
const RandomLanding = lazy(() => import('@/features/randomMix/pages/RandomLanding'));
const AlbumDetail = lazy(() => import('@/features/album/pages/AlbumDetail'));
const MostPlayed = lazy(() => import('@/features/album/pages/MostPlayed'));
const LosslessAlbums = lazy(() => import('@/features/album/pages/LosslessAlbums'));
const RandomAlbums = lazy(() => import('@/features/album/pages/RandomAlbums'));
const LuckyMixPage = lazy(() => import('@/features/randomMix/pages/LuckyMix'));
const Playlists = lazy(() => import('@/features/playlist/pages/Playlists'));
const PlaylistDetail = lazy(() => import('@/features/playlist/pages/PlaylistDetail'));
const NowPlayingPage = lazy(() => import('@/features/nowPlaying/pages/NowPlaying'));
const Settings = lazy(() => import('@/features/settings/pages/Settings'));
const Statistics = lazy(() => import('@/features/stats/pages/Statistics'));
const Help = lazy(() => import('@/features/help/pages/Help'));
const WhatsNew = lazy(() => import('@/features/whatsNew/pages/WhatsNew'));
const DeviceSync = lazy(() => import('@/features/deviceSync/pages/DeviceSync'));
const OfflineLibrary = lazy(() => import('@/features/offline/pages/OfflineLibrary'));
const LabelAlbums = lazy(() => import('@/features/album/pages/LabelAlbums'));
const SearchBrowsePage = lazy(() => import('@/features/search/pages/SearchBrowsePage'));
const FolderBrowser = lazy(() => import('@/features/folderBrowser/pages/FolderBrowser'));
const InternetRadio = lazy(() => import('@/features/radio/pages/InternetRadio'));
const Genres = lazy(() => import('@/features/genre/pages/Genres'));
const GenreDetail = lazy(() => import('@/features/genre/pages/GenreDetail'));

/**
 * Index route ("/") = Mainstage. When the user has hidden Mainstage from the
 * sidebar there is no nav link back to it, so landing on "/" would strand them
 * on a page they deliberately removed (and which is blank when its sections are
 * all off too). In that case redirect to the first visible library entry —
 * mirroring the sidebar's own ordering — so the app never opens on a dead page.
 */
function MainstageRoute() {
  const items = useSidebarStore(s => s.items);
  const randomNavMode = useAuthStore(s => s.randomNavMode);
  const luckyMixAvailable = useLuckyMixAvailable() && randomNavMode === 'separate';
  const mainstageVisible = items.find(i => i.id === 'mainstage')?.visible ?? true;
  if (mainstageVisible) return <Home />;
  const target = resolveStartRoute(items, randomNavMode, luckyMixAvailable);
  return target ? <Navigate to={target} replace /> : <Home />;
}

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
      <Route path="/" element={<MainstageRoute />} />
      <Route path="/albums" element={<Albums />} />
      <Route path="/tracks" element={<SearchBrowsePage />} />
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
      <Route path="/search" element={<SearchBrowsePage />} />
      <Route path="/search/advanced" element={<SearchBrowsePage />} />
      <Route path="/statistics" element={<Statistics />} />
      <Route path="/player-stats" element={<Statistics />} />
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
