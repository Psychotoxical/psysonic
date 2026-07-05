import { describe, expect, it } from 'vitest';
import {
  getLuckyMixLibraryScopeOverride,
  runWithLuckyMixLibraryScope,
} from '@/lib/library/luckyMixScopeOverride';
import { libraryFilterParamsForServer } from '@/lib/api/subsonicClient';
import { useAuthStore } from '@/store/authStore';

describe('luckyMixScopeOverride', () => {
  it('scopes Subsonic params to the override library during Lucky Mix', async () => {
    useAuthStore.setState({
      activeServerId: 'srv-1',
      musicLibrarySelectionByServer: { 'srv-1': ['1', '2'] },
      musicLibraryFilterByServer: { 'srv-1': '1' },
    });

    expect(getLuckyMixLibraryScopeOverride()).toBeNull();
    expect(libraryFilterParamsForServer('srv-1')).toEqual({ musicFolderId: ['1', '2'] });

    await runWithLuckyMixLibraryScope('2', async () => {
      expect(getLuckyMixLibraryScopeOverride()).toBe('2');
      expect(libraryFilterParamsForServer('srv-1')).toEqual({ musicFolderId: '2' });
    });

    expect(getLuckyMixLibraryScopeOverride()).toBeNull();
    expect(libraryFilterParamsForServer('srv-1')).toEqual({ musicFolderId: ['1', '2'] });
  });
});
