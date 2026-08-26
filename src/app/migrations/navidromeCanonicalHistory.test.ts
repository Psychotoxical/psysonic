import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from './navidromeCanonicalCheckpoint';
import {
  installNavidromeCanonicalHistoryNormalizer,
  rewriteNavidromeCanonicalHistoryForReadyServers,
  rewriteNavidromeCanonicalHistoryForScope,
} from './navidromeCanonicalHistory';

const LEGACY = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const CANONICAL = canonicalNavidromeId(LEGACY);
const PLAYLIST_LEGACY = '123e4567-e89b-12d3-a456-426614174000';
const PLAYLIST_CANONICAL = canonicalNavidromeId(PLAYLIST_LEGACY);
const scope = {
  serverIndexKey: 'music.test',
  profileIds: ['profile-a'],
  profileServerIndexKeys: { 'profile-a': 'music.test', other: 'other.test' },
};

function auth(): string {
  return JSON.stringify({
    state: {
      activeServerId: 'profile-a',
      servers: [
        {
          id: 'profile-a', name: 'Music', url: 'https://music.test',
          username: 'user', password: 'pass',
        },
        {
          id: 'other', name: 'Other', url: 'https://other.test',
          username: 'user', password: 'pass',
        },
      ],
    },
    version: 1,
  });
}

function seedReadyCheckpoint(): void {
  localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
    version: 1,
    servers: {
      'music.test': {
        sourceVersion: '0.64.0', checkedVersion: '0.64.0', canonicalVersion: 1,
        phase: 'ready', step: null, cursorRowid: 0, upperRowid: 0,
        cursorKey: null, upperKey: null, startedAt: 1, updatedAt: 1,
        localCompletedAt: 1, syncCompletedAt: 1, lastError: null,
      },
    },
  }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('psysonic-auth', auth());
  window.history.replaceState(null, '', '/');
});

describe('Navidrome canonical route history', () => {
  it('rewrites the current detail route and recursive React Router return state', () => {
    window.history.replaceState({
      usr: {
        returnTo: `/playlists/${PLAYLIST_LEGACY}?server=profile-a`,
        returnState: { returnTo: `/album/${LEGACY}` },
      },
      idx: 4,
    }, '', `/artist/${LEGACY}?server=profile-a#bio`);

    expect(rewriteNavidromeCanonicalHistoryForScope(scope)).toBe(true);

    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`)
      .toBe(`/artist/${CANONICAL}?server=profile-a#bio`);
    expect(window.history.state).toMatchObject({
      usr: {
        returnTo: `/playlists/${PLAYLIST_CANONICAL}?server=profile-a`,
        returnState: { returnTo: `/album/${CANONICAL}` },
      },
      idx: 4,
    });
    expect(rewriteNavidromeCanonicalHistoryForScope(scope)).toBe(false);
  });

  it('normalizes an active-owner playlist bookmark only after its checkpoint is ready', () => {
    seedReadyCheckpoint();
    window.history.replaceState(null, '', `/playlists/${PLAYLIST_LEGACY}`);

    expect(rewriteNavidromeCanonicalHistoryForReadyServers()).toBe(true);
    expect(window.location.pathname).toBe(`/playlists/${PLAYLIST_CANONICAL}`);
  });

  it('leaves a route owned by another server unchanged', () => {
    window.history.replaceState(null, '', `/composer/${LEGACY}?server=other`);

    expect(rewriteNavidromeCanonicalHistoryForScope(scope)).toBe(false);
    expect(window.location.pathname).toBe(`/composer/${LEGACY}`);
  });

  it('normalizes runtime pushState and replaceState navigation without recursion', () => {
    seedReadyCheckpoint();
    const uninstall = installNavidromeCanonicalHistoryNormalizer();
    try {
      window.history.pushState({
        usr: { returnTo: `/album/${LEGACY}?server=profile-a` },
      }, '', `/artist/${LEGACY}?server=profile-a`);
      expect(window.location.pathname).toBe(`/artist/${CANONICAL}`);
      expect(window.history.state).toMatchObject({
        usr: { returnTo: `/album/${CANONICAL}?server=profile-a` },
      });

      window.history.replaceState(null, '', `/playlists/${PLAYLIST_LEGACY}`);
      expect(window.location.pathname).toBe(`/playlists/${PLAYLIST_CANONICAL}`);
    } finally {
      uninstall();
    }
  });
});
