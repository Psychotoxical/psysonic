import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Lazy-route resolvability guard (residual-risk #4 from the PR #1225 review).
//
// Every page is code-split behind `lazy(() => import('@/features/*/pages/*'))`, so a
// broken specifier (a moved/renamed page the restructure missed) only fails when the
// route is first navigated to — not at build. This loop imports each lazy page up
// front and asserts a default-exported component, turning that runtime failure into a
// CI failure without any E2E.
//
// The thunks are LITERAL `import('...')` calls: Vite statically analyzes those and
// resolves the `@/` alias, whereas a runtime-variable `import(spec)` would not resolve
// reliably. The drift guard below reads the real route sources and fails if this table
// and the app fall out of sync, so a newly added route can't silently skip coverage.
const ROUTE_LOADERS: Array<[string, () => Promise<{ default: unknown }>]> = [
  ['@/features/home/pages/Home', () => import('@/features/home/pages/Home')],
  ['@/features/album/pages/Albums', () => import('@/features/album/pages/Albums')],
  ['@/features/album/pages/AlbumDetail', () => import('@/features/album/pages/AlbumDetail')],
  ['@/features/album/pages/NewReleases', () => import('@/features/album/pages/NewReleases')],
  ['@/features/album/pages/MostPlayed', () => import('@/features/album/pages/MostPlayed')],
  ['@/features/album/pages/LosslessAlbums', () => import('@/features/album/pages/LosslessAlbums')],
  ['@/features/album/pages/RandomAlbums', () => import('@/features/album/pages/RandomAlbums')],
  ['@/features/album/pages/LabelAlbums', () => import('@/features/album/pages/LabelAlbums')],
  ['@/features/artist/pages/Artists', () => import('@/features/artist/pages/Artists')],
  ['@/features/artist/pages/ArtistDetail', () => import('@/features/artist/pages/ArtistDetail')],
  ['@/features/composers/pages/Composers', () => import('@/features/composers/pages/Composers')],
  ['@/features/composers/pages/ComposerDetail', () => import('@/features/composers/pages/ComposerDetail')],
  ['@/features/favorites/pages/Favorites', () => import('@/features/favorites/pages/Favorites')],
  ['@/features/randomMix/pages/RandomMix', () => import('@/features/randomMix/pages/RandomMix')],
  ['@/features/randomMix/pages/RandomLanding', () => import('@/features/randomMix/pages/RandomLanding')],
  ['@/features/randomMix/pages/LuckyMix', () => import('@/features/randomMix/pages/LuckyMix')],
  ['@/features/playlist/pages/Playlists', () => import('@/features/playlist/pages/Playlists')],
  ['@/features/playlist/pages/PlaylistDetail', () => import('@/features/playlist/pages/PlaylistDetail')],
  ['@/features/nowPlaying/pages/NowPlaying', () => import('@/features/nowPlaying/pages/NowPlaying')],
  ['@/features/settings/pages/Settings', () => import('@/features/settings/pages/Settings')],
  ['@/features/stats/pages/Statistics', () => import('@/features/stats/pages/Statistics')],
  ['@/features/help/pages/Help', () => import('@/features/help/pages/Help')],
  ['@/features/whatsNew/pages/WhatsNew', () => import('@/features/whatsNew/pages/WhatsNew')],
  ['@/features/deviceSync/pages/DeviceSync', () => import('@/features/deviceSync/pages/DeviceSync')],
  ['@/features/offline/pages/OfflineLibrary', () => import('@/features/offline/pages/OfflineLibrary')],
  ['@/features/search/pages/SearchBrowsePage', () => import('@/features/search/pages/SearchBrowsePage')],
  ['@/features/folderBrowser/pages/FolderBrowser', () => import('@/features/folderBrowser/pages/FolderBrowser')],
  ['@/features/radio/pages/InternetRadio', () => import('@/features/radio/pages/InternetRadio')],
  ['@/features/genre/pages/Genres', () => import('@/features/genre/pages/Genres')],
  ['@/features/genre/pages/GenreDetail', () => import('@/features/genre/pages/GenreDetail')],
  ['@/features/auth/pages/Login', () => import('@/features/auth/pages/Login')],
];

describe('lazy-route resolvability smoke', () => {
  it.each(ROUTE_LOADERS)('resolves %s to a component', async (_spec, load) => {
    const mod = await load();
    expect(typeof mod.default).toBe('function');
  });

  it('covers every lazy page route declared in the app (drift guard)', () => {
    const sources = ['src/app/AppRoutes.tsx', 'src/app/MainApp.tsx']
      .map((rel) => readFileSync(resolve(process.cwd(), rel), 'utf8'))
      .join('\n');
    const declared = new Set(
      [...sources.matchAll(/lazy\(\(\)\s*=>\s*import\('([^']+)'\)\)/g)].map((m) => m[1]),
    );
    const covered = new Set(ROUTE_LOADERS.map(([spec]) => spec));
    // Symmetric difference must be empty: a route added to the app but not this
    // table (or removed from the app but left here) fails → keep the two in sync.
    const missing = [...declared].filter((spec) => !covered.has(spec));
    const extra = [...covered].filter((spec) => !declared.has(spec));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});
