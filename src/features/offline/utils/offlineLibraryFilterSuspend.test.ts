import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import {
  resetOfflineLibraryFilterSuspendState,
  restoreMusicLibraryFiltersAfterOffline,
  suspendMusicLibraryFiltersForOffline,
} from '@/features/offline/utils/offlineLibraryFilterSuspend';

describe('offlineLibraryFilterSuspend', () => {
  beforeEach(() => {
    resetOfflineLibraryFilterSuspendState();
    useAuthStore.setState({
      activeServerId: 'srv-a',
      musicLibraryFilterByServer: { 'srv-a': 'lib-1' },
      musicLibraryFilterVersion: 0,
    });
  });

  it('suspend saves scoped filter and resets active server to all', () => {
    suspendMusicLibraryFiltersForOffline();
    expect(useAuthStore.getState().musicLibraryFilterByServer['srv-a']).toBe('all');
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(1);
  });

  it('restore brings back the saved filter after reconnect', () => {
    suspendMusicLibraryFiltersForOffline();
    restoreMusicLibraryFiltersAfterOffline();
    expect(useAuthStore.getState().musicLibraryFilterByServer['srv-a']).toBe('lib-1');
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(2);
  });
});
