import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { flushMusicLibraryFilterVersionBumpForTests } from '@/store/musicLibraryFilterNotify';
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
      musicLibrarySelectionByServer: {},
      musicLibraryFilterByServer: { 'srv-a': 'lib-1' },
      musicLibraryFilterVersion: 0,
    });
  });

  it('suspend saves scoped filter and resets active server to all', () => {
    suspendMusicLibraryFiltersForOffline();
    // Catalog-version bump is deferred (see musicLibraryFilterNotify); flush it.
    flushMusicLibraryFilterVersionBumpForTests();
    expect(useAuthStore.getState().musicLibraryFilterByServer['srv-a']).toBe('all');
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(1);
  });

  it('restore brings back the saved filter after reconnect', () => {
    suspendMusicLibraryFiltersForOffline();
    flushMusicLibraryFilterVersionBumpForTests();
    restoreMusicLibraryFiltersAfterOffline();
    flushMusicLibraryFilterVersionBumpForTests();
    expect(useAuthStore.getState().musicLibraryFilterByServer['srv-a']).toBe('lib-1');
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(2);
  });

  it('suspends and restores a multi-library ordered selection', () => {
    useAuthStore.setState({
      activeServerId: 'srv-a',
      musicLibrarySelectionByServer: { 'srv-a': ['lib-1', 'lib-2'] },
      musicLibraryFilterByServer: { 'srv-a': 'lib-1' },
      musicLibraryFilterVersion: 0,
    });

    suspendMusicLibraryFiltersForOffline();
    flushMusicLibraryFilterVersionBumpForTests();
    // Offline: readers see an empty selection (browse all), not the narrowed set.
    expect(useAuthStore.getState().musicLibrarySelectionByServer['srv-a']).toEqual([]);
    expect(useAuthStore.getState().musicLibraryFilterByServer['srv-a']).toBe('all');

    restoreMusicLibraryFiltersAfterOffline();
    flushMusicLibraryFilterVersionBumpForTests();
    expect(useAuthStore.getState().musicLibrarySelectionByServer['srv-a']).toEqual(['lib-1', 'lib-2']);
  });
});
