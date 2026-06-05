import { describe, expect, it } from 'vitest';
import { entryNeedsFileRelocation } from './legacyOfflineFileMigration';
import type { LocalPlaybackEntry } from '../../store/localPlaybackStore';

function entry(overrides: Partial<LocalPlaybackEntry>): LocalPlaybackEntry {
  return {
    serverIndexKey: 'srv',
    trackId: 't1',
    localPath: '/old/path',
    layoutFingerprint: '',
    sizeBytes: 0,
    tier: 'library',
    cachedAt: 1,
    suffix: 'mp3',
    ...overrides,
  };
}

describe('entryNeedsFileRelocation', () => {
  it('detects psysonic-offline flat paths', () => {
    expect(entryNeedsFileRelocation(entry({
      localPath: '/home/u/.local/share/psysonic-offline/host/t1.mp3',
    }))).toBe(true);
  });

  it('skips paths already under media/library', () => {
    expect(entryNeedsFileRelocation(entry({
      localPath: '/home/u/.local/share/media/library/host/Artist/Album/01 - Song.mp3',
    }))).toBe(false);
  });

  it('skips ephemeral tier', () => {
    expect(entryNeedsFileRelocation(entry({
      tier: 'ephemeral',
      localPath: '/home/u/psysonic-offline/host/t1.mp3',
    }))).toBe(false);
  });
});
