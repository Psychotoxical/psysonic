import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { useBrowseLibraryScope } from './useBrowseLibraryScope';

function ready(serverId: string) {
  return {
    serverId,
    libraryScope: '',
    syncPhase: 'ready',
    capabilityFlags: 0,
    libraryTier: '',
  };
}

describe('useBrowseLibraryScope', () => {
  beforeEach(() => {
    useAuthStore.setState({
      servers: [
        { id: 's2', name: 'Two', url: 'https://two.test', username: 'u', password: 'p' },
        { id: 's1', name: 'One', url: 'https://one.test', username: 'u', password: 'p' },
      ],
      activeServerId: 's1',
      musicLibraryServerIds: ['s1', 's2'],
      musicLibrarySelectionByServer: { s1: ['a'], s2: [] },
      musicLibraryFilterByServer: {},
    });
    useLibraryIndexStore.setState({
      statusByServer: { 'one.test': ready('one.test'), 'two.test': ready('two.test') },
      connectionByServer: { 'one.test': 'online', 'two.test': 'online' },
    });
  });

  it('returns common-order pairs, anchor, and ordered fingerprint', () => {
    const { result } = renderHook(() => useBrowseLibraryScope());
    expect(result.current.pairs).toEqual([
      { serverId: 's2', libraryId: null },
      { serverId: 's1', libraryId: 'a' },
    ]);
    expect(result.current.anchorServerId).toBe('s2');
    expect(result.current.multiServer).toBe(true);
    expect(result.current.fingerprint).toBe('[["s2",null],["s1","a"]]');
  });

  it('excludes unavailable sources without falling back to the active server', () => {
    useLibraryIndexStore.setState({
      statusByServer: { 'one.test': ready('one.test'), 'two.test': ready('two.test') },
      connectionByServer: { 'one.test': 'offline', 'two.test': 'online' },
    });
    const { result } = renderHook(() => useBrowseLibraryScope());
    expect(result.current.pairs).toEqual([{ serverId: 's2', libraryId: null }]);
    expect(result.current.anchorServerId).toBe('s2');
    expect(result.current.multiServer).toBe(true);
  });

  it.each(['primary', 'alias', null])('uses the same owner for exact aliases when active is %s', activeServerId => {
    useAuthStore.setState({
      servers: [
        { id: 'primary', name: 'Primary', url: 'https://same.test', username: 'u', password: 'p' },
        { id: 'alias', name: 'Alias', url: 'http://same.test/', username: 'u', password: 'p' },
      ],
      activeServerId,
      musicLibraryServerIds: ['alias', 'primary'],
      musicLibrarySelectionByServer: { primary: ['one'], alias: ['two'] },
      musicLibraryFilterByServer: {},
    });
    useLibraryIndexStore.setState({
      statusByServer: { 'same.test': ready('same.test') },
      connectionByServer: { 'same.test': 'online' },
    });

    const { result } = renderHook(() => useBrowseLibraryScope());
    expect(result.current.pairs).toEqual([
      { serverId: 'primary', libraryId: 'one' },
      { serverId: 'primary', libraryId: 'two' },
    ]);
    expect(result.current.anchorServerId).toBe('primary');
    expect(result.current.configuredServerIds).toEqual(['primary']);
    expect(result.current.multiServer).toBe(false);
  });

  it('coalesces a whole-library alias under the same deterministic owner', () => {
    useAuthStore.setState({
      servers: [
        { id: 'primary', name: 'Primary', url: 'https://same.test', username: 'u', password: 'p' },
        { id: 'alias', name: 'Alias', url: 'http://same.test/', username: 'u', password: 'p' },
      ],
      activeServerId: 'alias',
      musicLibraryServerIds: ['primary', 'alias'],
      musicLibrarySelectionByServer: { primary: ['one'], alias: [] },
      musicLibraryFilterByServer: {},
    });
    useLibraryIndexStore.setState({
      statusByServer: { 'same.test': ready('same.test') },
      connectionByServer: { 'same.test': 'online' },
    });

    const { result } = renderHook(() => useBrowseLibraryScope());
    expect(result.current.pairs).toEqual([{ serverId: 'primary', libraryId: null }]);
    expect(result.current.anchorServerId).toBe('primary');
  });
});
