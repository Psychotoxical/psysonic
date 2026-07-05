import { useLocation } from 'react-router-dom';

/** Bumps when disconnect fork chooses stay-reload ({@link useOfflineAutoNav}). */
export function useOfflineBrowseReloadToken(): number | undefined {
  const location = useLocation();
  const state = location.state as { offlineBrowseReloadTs?: number } | null;
  return state?.offlineBrowseReloadTs;
}
