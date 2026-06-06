import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

export function createCacheStorageActions(set: SetState): Pick<
  AuthState,
  | 'setMaxCacheMb'
  | 'setDownloadFolder'
  | 'setOfflineDownloadDir'
  | 'setFavoritesOfflineEnabled'
  | 'setHotCacheEnabled'
  | 'setHotCacheMaxMb'
  | 'setHotCacheDebounceSec'
  | 'setHotCacheDownloadDir'
  | 'setMediaDir'
> {
  return {
    setMaxCacheMb: (v) => set({ maxCacheMb: v }),
    setDownloadFolder: (v) => set({ downloadFolder: v }),
    setOfflineDownloadDir: (v) => set({ offlineDownloadDir: v }),
    setFavoritesOfflineEnabled: (v) => set({ favoritesOfflineEnabled: v }),
    setHotCacheEnabled: (v) => set({ hotCacheEnabled: v }),
    setHotCacheMaxMb: (v) => set({ hotCacheMaxMb: v }),
    setHotCacheDebounceSec: (v) => set({ hotCacheDebounceSec: v }),
    setHotCacheDownloadDir: (v) => set({ hotCacheDownloadDir: v }),
    setMediaDir: (v) => set({ mediaDir: v }),
  };
}
