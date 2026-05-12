import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

export function createCacheStorageActions(set: SetState): Pick<
  AuthState,
  | 'setMaxCacheMb'
  | 'setDownloadFolder'
  | 'setOfflineDownloadDir'
  | 'setHotCacheEnabled'
  | 'setHotCacheMaxMb'
  | 'setHotCacheDebounceSec'
  | 'setHotCacheDownloadDir'
> {
  return {
    setMaxCacheMb: (v) => set({ maxCacheMb: v }),
    setDownloadFolder: (v) => set({ downloadFolder: v }),
    setOfflineDownloadDir: (v) => set({ offlineDownloadDir: v }),
    setHotCacheEnabled: (v) => set({ hotCacheEnabled: v }),
    setHotCacheMaxMb: (v) => set({ hotCacheMaxMb: v }),
    setHotCacheDebounceSec: (v) => set({ hotCacheDebounceSec: v }),
    setHotCacheDownloadDir: (v) => set({ hotCacheDownloadDir: v }),
  };
}
