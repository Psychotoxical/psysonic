import { useAuthStore } from '@/store/authStore';
import { useThemeStore } from '@/store/themeStore';

export type TrackListCoverArtSurface = 'queue' | 'pages';

/** Separate persisted toggles: queue chrome vs browse tracklists. */
export function useTrackListCoverArtEnabled(surface: TrackListCoverArtSurface): boolean {
  const queueEnabled = useAuthStore(s => s.queueTrackListCovers);
  const pagesEnabled = useThemeStore(s => s.trackListCoverArtOnPages);
  return surface === 'queue' ? queueEnabled : pagesEnabled;
}
