import { describe, expect, it } from 'vitest';
import {
  buildBrowseLibraryScopePairs,
  buildBrowseScopeExcludedSources,
  buildConfiguredLibraryScopePairs,
  buildMutationLibraryScope,
  buildReachableLibrarySources,
  configuredLibraryServerIds,
  libraryScopeFingerprint,
} from './libraryBrowseScope';
import type { SyncStateDto } from '@/lib/api/library';

function readyStatus(serverId: string): SyncStateDto {
  return {
    serverId,
    libraryScope: '',
    syncPhase: 'ready',
    capabilityFlags: 0,
    libraryTier: '',
  };
}

describe('libraryBrowseScope', () => {
  const state = {
    servers: [
      { id: 'b', url: 'https://b.example' },
      { id: 'a', url: 'https://a.example' },
      { id: 'c', url: 'https://c.example' },
    ],
    musicLibraryServerIds: ['a', 'b'],
    musicLibrarySelectionByServer: {
      a: ['a-2', 'a-1'],
      b: ['b-1'],
    },
    musicLibraryFilterByServer: {},
  };

  it('derives selected server membership from common server order', () => {
    expect(configuredLibraryServerIds(state)).toEqual(['b', 'a']);
  });

  it('flattens server priority before per-server library priority', () => {
    expect(buildConfiguredLibraryScopePairs(state)).toEqual([
      { serverId: 'b', libraryId: 'b-1' },
      { serverId: 'a', libraryId: 'a-2' },
      { serverId: 'a', libraryId: 'a-1' },
    ]);
  });

  it('coalesces selected profiles sharing one index key under the first profile owner', () => {
    expect(buildConfiguredLibraryScopePairs({
      ...state,
      servers: [
        { id: 'primary', url: 'https://same.example' },
        { id: 'alias', url: 'http://same.example/' },
      ],
      musicLibraryServerIds: ['alias', 'primary'],
      musicLibrarySelectionByServer: {
        primary: ['shared', 'primary-only'],
        alias: ['alias-only', 'shared'],
      },
    })).toEqual([
      { serverId: 'primary', libraryId: 'shared' },
      { serverId: 'primary', libraryId: 'primary-only' },
      { serverId: 'primary', libraryId: 'alias-only' },
    ]);
  });

  it('lets an all-libraries alias dominate exact selections for the shared index', () => {
    expect(buildConfiguredLibraryScopePairs({
      ...state,
      servers: [
        { id: 'primary', url: 'https://same.example' },
        { id: 'alias', url: 'http://same.example/' },
      ],
      musicLibraryServerIds: ['primary', 'alias'],
      musicLibrarySelectionByServer: { primary: ['one'], alias: [] },
    })).toEqual([{ serverId: 'primary', libraryId: null }]);
  });

  it('emits a whole-server pair for an all-libraries selection', () => {
    expect(buildConfiguredLibraryScopePairs({
      ...state,
      musicLibrarySelectionByServer: { a: [], b: ['b-1'] },
    })).toEqual([
      { serverId: 'b', libraryId: 'b-1' },
      { serverId: 'a', libraryId: null },
    ]);
  });

  it('preserves an explicit empty library id as an exact source', () => {
    expect(buildConfiguredLibraryScopePairs({
      ...state,
      musicLibraryServerIds: ['a'],
      musicLibrarySelectionByServer: { a: [''] },
    })).toEqual([{ serverId: 'a', libraryId: '' }]);
  });

  it('maps canonical runtime keys back to profile ids for browse membership', () => {
    expect(buildBrowseLibraryScopePairs(state, {
      statusByServer: {
        'b.example': readyStatus('b.example'),
        'a.example': readyStatus('a.example'),
      },
      connectionByServer: {
        'b.example': 'online',
        'a.example': 'offline',
      },
    })).toEqual([{ serverId: 'b', libraryId: 'b-1' }]);
  });

  it('lists selected reachable live sources without requiring index readiness', () => {
    expect(buildReachableLibrarySources({
      ...state,
      servers: state.servers.map(server => ({ ...server, name: server.id.toUpperCase() })),
    }, {
      connectionByServer: {
        'b.example': 'online',
        'a.example': 'offline',
      },
    })).toEqual([{ serverId: 'b', name: 'B' }]);
  });

  it('keeps every selected server in mutation membership with readiness', () => {
    expect(buildMutationLibraryScope(state, {
      statusByServer: { 'b.example': readyStatus('b.example') },
      connectionByServer: {
        'b.example': 'offline',
        'a.example': 'online',
      },
    })).toEqual([
      {
        serverId: 'b',
        readiness: 'ready',
        pairs: [{ serverId: 'b', libraryId: 'b-1' }],
      },
      {
        serverId: 'a',
        readiness: 'not_ready',
        pairs: [
          { serverId: 'a', libraryId: 'a-2' },
          { serverId: 'a', libraryId: 'a-1' },
        ],
      },
    ]);
  });

  it('exposes offline, unknown, and not-ready exclusion reasons', () => {
    expect(buildBrowseScopeExcludedSources(state, {
      statusByServer: { 'b.example': readyStatus('b.example') },
      connectionByServer: {
        'b.example': 'offline',
        'a.example': 'unknown',
      },
    })).toEqual([
      { serverId: 'b', reasons: ['offline'] },
      { serverId: 'a', reasons: ['connection_unknown', 'index_not_ready'] },
    ]);
  });

  it('uses the navigator offline hint to exclude every configured source', () => {
    const runtime = {
      statusByServer: {
        'b.example': readyStatus('b.example'),
        'a.example': readyStatus('a.example'),
      },
      connectionByServer: {
        'b.example': 'online' as const,
        'a.example': 'online' as const,
      },
    };
    expect(buildBrowseLibraryScopePairs(state, runtime, { navigatorOffline: true })).toEqual([]);
    expect(buildBrowseScopeExcludedSources(state, runtime, { navigatorOffline: true })).toEqual([
      { serverId: 'b', reasons: ['offline'] },
      { serverId: 'a', reasons: ['offline'] },
    ]);
  });

  it('fingerprints pair order and identity deterministically', () => {
    const pairs = buildConfiguredLibraryScopePairs(state);
    expect(libraryScopeFingerprint(pairs)).toBe(
      '[["b","b-1"],["a","a-2"],["a","a-1"]]',
    );
    expect(libraryScopeFingerprint([...pairs].reverse())).not.toBe(libraryScopeFingerprint(pairs));
  });
});
