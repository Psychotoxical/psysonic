import { beforeEach, describe, expect, it, vi } from 'vitest';

const servers = vi.hoisted(() => [] as Array<{ id: string; url: string }>);

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({ servers }),
  },
}));

import {
  looksLikeGeneratedProfileId,
  resolveStorageServerIndexKey,
} from '@/lib/server/serverIndexKey';

const PROFILE_ID = '7d9f7c36-1c55-4a6f-ae24-87ab823f5b61';

beforeEach(() => {
  servers.splice(0, servers.length);
});

describe('resolveStorageServerIndexKey', () => {
  it('resolves a known profile UUID through its primary URL', () => {
    servers.push({ id: PROFILE_ID, url: 'https://music.example.test/subsonic/' });
    expect(resolveStorageServerIndexKey(PROFILE_ID)).toBe('music.example.test/subsonic');
  });

  it('rejects an unknown profile UUID instead of using it as a storage key', () => {
    expect(resolveStorageServerIndexKey('9ee02895-4d12-4faa-9a9f-3fae22b64d18')).toBeNull();
  });

  it('rejects an unknown base36 profile id instead of using it as a storage key', () => {
    // `generateId()` shape: Date.now().toString(36) + Math.random().toString(36).slice(2).
    // The library keys rows by address; a profile id leaking through as a "host"
    // is what made every enrichment write fail on its foreign key (#1434).
    const mintedNow = Date.now().toString(36) + 'k2ff7q1zt';
    const mintedApril2026 = Date.UTC(2026, 3, 15).toString(36) + 'k2ff7q1zt';
    expect(resolveStorageServerIndexKey(mintedNow)).toBeNull();
    expect(resolveStorageServerIndexKey(mintedApril2026)).toBeNull();
  });

  it('resolves a known base36 profile id through its primary URL', () => {
    servers.push({ id: 'mabc12x9k2ff7q1zt', url: 'https://music.example.test/' });
    expect(resolveStorageServerIndexKey('mabc12x9k2ff7q1zt')).toBe('music.example.test');
  });

  it('keeps the index key of a configured server even when it is shaped like a profile id', () => {
    // `mpserver` decodes to May 2026, inside the plausible minting window.
    servers.push({ id: PROFILE_ID, url: 'http://mpserver' });
    expect(looksLikeGeneratedProfileId('mpserver')).toBe(true);
    expect(resolveStorageServerIndexKey('mpserver')).toBe('mpserver');
  });

  it('keeps keys that are not shaped like a generated profile id', () => {
    expect(resolveStorageServerIndexKey('server-a')).toBe('server-a');
    expect(resolveStorageServerIndexKey('s1')).toBe('s1');
    expect(resolveStorageServerIndexKey('localhost')).toBe('localhost');
    expect(resolveStorageServerIndexKey('navidrome:4533')).toBe('navidrome:4533');
    expect(resolveStorageServerIndexKey('192.0.2.10:4533')).toBe('192.0.2.10:4533');
  });

  it('only treats a base36 word as a profile id when its timestamp is plausible', () => {
    expect(looksLikeGeneratedProfileId('mpve60xt6p6nxkbmf6')).toBe(true);
    // Decode to 2023 and 2025: minted before any Psysonic profile existed.
    expect(looksLikeGeneratedProfileId('localhost')).toBe(false);
    expect(looksLikeGeneratedProfileId('mediaserver')).toBe(false);
    // Decodes to 2056: a timestamp from the future is not a minted id.
    expect(looksLikeGeneratedProfileId('zerobased')).toBe(false);
    expect(looksLikeGeneratedProfileId('server-a')).toBe(false);
  });

  it('normalizes a primary URL into the existing address-derived key', () => {
    expect(resolveStorageServerIndexKey('https://music.example.test/subsonic/'))
      .toBe('music.example.test/subsonic');
  });

  it('keeps an existing URL-derived index key stable', () => {
    expect(resolveStorageServerIndexKey('music.example.test/subsonic'))
      .toBe('music.example.test/subsonic');
  });

  it('rejects empty input', () => {
    expect(resolveStorageServerIndexKey('   ')).toBeNull();
  });
});
