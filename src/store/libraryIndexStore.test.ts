import { beforeEach, describe, expect, it } from 'vitest';
import { useLibraryIndexStore } from './libraryIndexStore';
import { getLibraryServerConnection } from '@/lib/network/libraryServerReachability';

const initial = useLibraryIndexStore.getState();

describe('libraryIndexStore runtime state', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({
      ...initial,
      statusByServer: {},
      connectionByServer: {},
    }, true);
    useLibraryIndexStore.getState().replaceConnections({});
  });

  it('shares canonical per-server status and connection snapshots', () => {
    useLibraryIndexStore.getState().replaceStatuses({
      'music.example.com': {
        serverId: 'music.example.com',
        libraryScope: '',
        syncPhase: 'ready',
        capabilityFlags: 0,
        libraryTier: '',
      },
    });
    useLibraryIndexStore.getState().replaceConnections({ 'music.example.com': 'online' });

    expect(useLibraryIndexStore.getState().statusByServer['music.example.com']?.syncPhase)
      .toBe('ready');
    expect(getLibraryServerConnection('music.example.com')).toBe('online');
  });

  it('merges one server update without dropping other server reachability', () => {
    useLibraryIndexStore.getState().replaceConnections({
      'a.example.com': 'online',
      'b.example.com': 'offline',
    });
    useLibraryIndexStore.getState().mergeConnections({ 'a.example.com': 'offline' });
    expect(useLibraryIndexStore.getState().connectionByServer).toEqual({
      'a.example.com': 'offline',
      'b.example.com': 'offline',
    });
  });
});
