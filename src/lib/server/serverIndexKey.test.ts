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

  it('keeps the index key of a configured server even when it is shaped like a profile id', () => {
    // `mpserver` decodes to May 2026, inside the plausible minting window.
    servers.push({ id: PROFILE_ID, url: 'http://mpserver' });
    expect(looksLikeGeneratedProfileId('mpserver')).toBe(true);
    expect(resolveStorageServerIndexKey('mpserver')).toBe('mpserver');
  });

  it('keeps an unconfigured bare hostname stable even when it resembles a profile id', () => {
    expect(looksLikeGeneratedProfileId('mpserver')).toBe(true);
    expect(resolveStorageServerIndexKey('mpserver')).toBe('mpserver');
    expect(resolveStorageServerIndexKey('http://mpserver')).toBe('mpserver');
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

  it('accepts generated profile ids with long suffixes and wider timestamps', () => {
    const mintedApril2026 = Date.UTC(2026, 3, 15);
    const longId = mintedApril2026.toString(36) + '000000000000em2djky0vz9';
    expect(longId.length).toBeGreaterThan(24);
    expect(looksLikeGeneratedProfileId(longId, mintedApril2026)).toBe(true);

    const firstNineDigitTimestamp = 36 ** 8;
    const futureId = firstNineDigitTimestamp.toString(36) + 'random';
    expect(looksLikeGeneratedProfileId(futureId, firstNineDigitTimestamp)).toBe(true);
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
