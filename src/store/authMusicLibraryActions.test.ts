import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { flushMusicLibraryFilterVersionBumpForTests } from '@/store/musicLibraryFilterNotify';

function setUpActiveServer(): string {
  const id = useAuthStore.getState().addServer({
    name: 'Test',
    url: 'https://music.example.com',
    username: 'alice',
    password: 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
  return id;
}

beforeEach(() => {
  resetAuthStore();
});

describe('setMusicLibrarySelection', () => {
  it('writes ordered selection, mirrors legacy, and bumps version after defer', () => {
    const serverId = setUpActiveServer();
    useAuthStore.getState().setMusicLibrarySelection(['lib-b', 'lib-a']);
    const state = useAuthStore.getState();
    expect(state.musicLibrarySelectionByServer[serverId]).toEqual(['lib-b', 'lib-a']);
    expect(state.musicLibraryFilterByServer[serverId]).toBe('lib-b');
    expect(state.musicLibraryFilterVersion).toBe(0);
    flushMusicLibraryFilterVersionBumpForTests();
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(1);
  });

  it('maps empty selection to legacy all', () => {
    const serverId = setUpActiveServer();
    useAuthStore.getState().setMusicLibrarySelection([]);
    const state = useAuthStore.getState();
    expect(state.musicLibrarySelectionByServer[serverId]).toEqual([]);
    expect(state.musicLibraryFilterByServer[serverId]).toBe('all');
  });

  it('maps single selection to legacy folder id', () => {
    const serverId = setUpActiveServer();
    useAuthStore.getState().setMusicLibrarySelection(['lib-1']);
    expect(useAuthStore.getState().musicLibraryFilterByServer[serverId]).toBe('lib-1');
  });

  it('collapses to all when the selection covers every folder', () => {
    const serverId = setUpActiveServer();
    useAuthStore.setState({
      musicFolders: [
        { id: 'lib-a', name: 'A' },
        { id: 'lib-b', name: 'B' },
      ],
    });
    useAuthStore.getState().setMusicLibrarySelection(['lib-a', 'lib-b']);
    const state = useAuthStore.getState();
    expect(state.musicLibrarySelectionByServer[serverId]).toEqual([]);
    expect(state.musicLibraryFilterByServer[serverId]).toBe('all');
  });

  it('keeps a partial selection when not all folders are covered', () => {
    const serverId = setUpActiveServer();
    useAuthStore.setState({
      musicFolders: [
        { id: 'lib-a', name: 'A' },
        { id: 'lib-b', name: 'B' },
      ],
    });
    useAuthStore.getState().setMusicLibrarySelection(['lib-a']);
    expect(useAuthStore.getState().musicLibrarySelectionByServer[serverId]).toEqual(['lib-a']);
  });
});

describe('setMusicFolders', () => {
  it('prunes stale selection entries and syncs legacy', () => {
    const serverId = setUpActiveServer();
    useAuthStore.setState({
      musicLibrarySelectionByServer: { [serverId]: ['gone', 'keep'] },
      musicLibraryFilterByServer: { [serverId]: 'gone' },
    });
    useAuthStore.getState().setMusicFolders([{ id: 'keep', name: 'Keep' }]);
    const state = useAuthStore.getState();
    expect(state.musicLibrarySelectionByServer[serverId]).toEqual(['keep']);
    expect(state.musicLibraryFilterByServer[serverId]).toBe('keep');
  });

  it('resets legacy filter to all when the single folder is gone', () => {
    const serverId = setUpActiveServer();
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'gone' },
    });
    useAuthStore.getState().setMusicFolders([{ id: 'new', name: 'New' }]);
    expect(useAuthStore.getState().musicLibraryFilterByServer[serverId]).toBe('all');
  });
});
