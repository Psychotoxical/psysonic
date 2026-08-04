import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import {
  browseScopeLibraryIdsForServer,
  deriveEntitySourceScopes,
  deriveEffectiveLibraryBrowseServerIds,
  deriveLibraryBrowseIndexScopes,
  deriveLibraryBrowseScope,
  getLibraryBrowseScope,
  hasConfiguredLibraryBrowseScope,
} from './libraryBrowseScope';

beforeEach(resetAuthStore);

describe('getLibraryBrowseScope', () => {
  it('derives per-server ids from explicit scope pairs', () => {
    const scopes = [
      { serverId: 'a', libraryId: 'a2' },
      { serverId: 'a', libraryId: 'a1' },
      { serverId: 'b', libraryId: null },
    ];

    expect(browseScopeLibraryIdsForServer(scopes, 'a')).toEqual(['a2', 'a1']);
    expect(browseScopeLibraryIdsForServer(scopes, 'b')).toEqual([]);
  });

  it('builds exact and whole-server pairs in server and folder priority order', () => {
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'b',
      libraryBrowseServerIds: ['a', 'b'],
      musicFoldersByServer: {
        a: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
        b: [{ id: 'b1', name: 'B1' }],
      },
      libraryBrowseSelectionByServer: { a: ['a2', 'a1'], b: [] },
    });

    expect(getLibraryBrowseScope()).toEqual({
      anchorServerId: 'a',
      serverIds: ['a', 'b'],
      pairs: [
        { serverId: 'a', libraryId: 'a2' },
        { serverId: 'a', libraryId: 'a1' },
        { serverId: 'b', libraryId: null },
      ],
      fingerprint: JSON.stringify([['a', ['a2', 'a1']], ['b', [null]]]),
      multiServer: true,
    });
  });

  it('keeps the persisted server priority independent of the active connection', () => {
    const scope = deriveLibraryBrowseScope({
      servers: [{ id: 'primary' }, { id: 'active' }],
      activeServerId: 'active',
      libraryBrowseServerIds: ['primary', 'active'],
      musicFoldersByServer: {},
      libraryBrowseSelectionByServer: {},
    });

    expect(scope.anchorServerId).toBe('primary');
    expect(scope.multiServer).toBe(true);
    expect(scope.fingerprint).toBe(JSON.stringify([['primary', [null]], ['active', [null]]]));
  });

  it('excludes confirmed unavailable servers without changing persisted membership', () => {
    const state = {
      servers: [{ id: 'primary' }, { id: 'secondary' }],
      activeServerId: 'primary',
      libraryBrowseServerIds: ['primary', 'secondary'],
      musicFoldersByServer: {
        primary: [{ id: 'primary-music' }],
        secondary: [{ id: 'secondary-music' }],
      },
      libraryBrowseSelectionByServer: {},
    };

    expect(deriveEffectiveLibraryBrowseServerIds(state, new Set(['primary'])))
      .toEqual(['secondary']);
    expect(deriveLibraryBrowseIndexScopes(state, new Set(['primary']))).toEqual([
      { serverId: 'secondary', libraryIds: [] },
    ]);
    expect(deriveLibraryBrowseScope(state, new Set(['primary']))).toEqual({
      anchorServerId: 'secondary',
      serverIds: ['secondary'],
      pairs: [{ serverId: 'secondary', libraryId: null }],
      fingerprint: JSON.stringify([['secondary', [null]]]),
      multiServer: false,
    });
    expect(state.libraryBrowseServerIds).toEqual(['primary', 'secondary']);
  });

  it('returns an empty effective scope when every selected server is unavailable', () => {
    const scope = deriveLibraryBrowseScope({
      servers: [{ id: 'a' }, { id: 'b' }],
      activeServerId: 'a',
      libraryBrowseServerIds: ['a', 'b'],
      musicFoldersByServer: { a: [{ id: 'a1' }], b: [{ id: 'b1' }] },
      libraryBrowseSelectionByServer: {},
    }, new Set(['a', 'b']));

    expect(scope).toEqual({
      anchorServerId: null,
      serverIds: [],
      pairs: [],
      fingerprint: '',
      multiServer: false,
    });
  });

  it('falls back defensively when persisted membership has no valid server', () => {
    const scope = deriveLibraryBrowseScope({
      servers: [{ id: 'first' }, { id: 'active' }],
      activeServerId: 'active',
      libraryBrowseServerIds: ['missing'],
      musicFoldersByServer: { active: [{ id: 'music' }] },
      libraryBrowseSelectionByServer: {},
    });

    expect(scope).toEqual({
      anchorServerId: 'active',
      serverIds: ['active'],
      pairs: [{ serverId: 'active', libraryId: null }],
      fingerprint: JSON.stringify([['active', [null]]]),
      multiServer: false,
    });
  });

  it('includes fallback library selection in the scope fingerprint', () => {
    const state = {
      servers: [{ id: 'active' }],
      activeServerId: 'active',
      libraryBrowseServerIds: [],
      musicFoldersByServer: { active: [{ id: 'one' }, { id: 'two' }] },
      libraryBrowseSelectionByServer: { active: ['two'] },
    };

    expect(deriveLibraryBrowseScope(state)).toMatchObject({
      pairs: [{ serverId: 'active', libraryId: 'two' }],
      fingerprint: JSON.stringify([['active', ['two']]]),
    });
    expect(deriveLibraryBrowseScope({
      ...state,
      libraryBrowseSelectionByServer: { active: ['one'] },
    }).fingerprint).toBe(JSON.stringify([['active', ['one']]]));
  });

  it('distinguishes configured membership from the active-server fallback', () => {
    useAuthStore.setState({
      servers: [{ id: 'active', name: 'Active', url: 'https://active.test', username: 'u', password: 'p' }],
      activeServerId: 'active',
      libraryBrowseServerIds: [],
    });
    expect(hasConfiguredLibraryBrowseScope()).toBe(false);

    useAuthStore.setState({ libraryBrowseServerIds: ['active'] });
    expect(hasConfiguredLibraryBrowseScope()).toBe(true);
  });

  it('uses configured source membership even when servers are unavailable', () => {
    const state = {
      servers: [{ id: 'primary' }, { id: 'offline' }],
      activeServerId: 'primary',
      libraryBrowseServerIds: ['primary', 'offline'],
      musicFoldersByServer: {},
      libraryBrowseSelectionByServer: { primary: ['music'], offline: [] },
    };

    expect(deriveEntitySourceScopes(state, 'anchor')).toEqual([
      { serverId: 'primary', libraryId: 'music' },
      { serverId: 'offline', libraryId: null },
    ]);
  });

  it('falls back to the concrete anchor when no configured pair exists', () => {
    expect(deriveEntitySourceScopes({
      servers: [{ id: 'active' }],
      activeServerId: 'active',
      libraryBrowseServerIds: [],
      musicFoldersByServer: {},
      libraryBrowseSelectionByServer: {},
    }, 'owner')).toEqual([{ serverId: 'owner', libraryId: null }]);
  });
});
