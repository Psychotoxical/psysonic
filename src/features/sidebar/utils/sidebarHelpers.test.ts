import { describe, expect, it } from 'vitest';
import { libraryScopeCacheKeyForServer } from '@/lib/api/subsonicClient';
import { useAuthStore } from '@/store/authStore';
import { newReleasesSeenStorageKey } from '@/features/sidebar/utils/sidebarHelpers';

describe('newReleasesSeenStorageKey', () => {
  it('uses the all-libraries segment when scope is empty', () => {
    useAuthStore.setState({
      activeServerId: 'srv-1',
      musicLibrarySelectionByServer: { 'srv-1': [] },
      musicLibraryFilterByServer: { 'srv-1': 'all' },
    });
    expect(libraryScopeCacheKeyForServer('srv-1')).toBe('all');
    expect(newReleasesSeenStorageKey('srv-1', 'all')).toBe(
      'psy_new_releases_unread_seen_v1:srv-1:all',
    );
  });

  it('uses a comma-joined scope key for multi-library selection', () => {
    useAuthStore.setState({
      activeServerId: 'srv-1',
      musicLibrarySelectionByServer: { 'srv-1': ['lib-b', 'lib-a'] },
      musicLibraryFilterByServer: { 'srv-1': 'lib-b' },
    });
    expect(libraryScopeCacheKeyForServer('srv-1')).toBe('lib-b,lib-a');
    expect(newReleasesSeenStorageKey('srv-1', libraryScopeCacheKeyForServer('srv-1'))).toBe(
      'psy_new_releases_unread_seen_v1:srv-1:lib-b,lib-a',
    );
  });
});
