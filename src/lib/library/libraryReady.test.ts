import { describe, expect, it } from 'vitest';
import type { SyncStateDto } from '@/lib/api/library';
import { libraryStatusIsReady, syncIngestDisplayCount } from './libraryReady';

const status = (over: Partial<SyncStateDto>): SyncStateDto => ({
  serverId: 's1',
  libraryScope: '',
  syncPhase: 'idle',
  capabilityFlags: 0,
  libraryTier: 'unknown',
  ...over,
});

describe('libraryStatusIsReady', () => {
  it('accepts ready', () => {
    expect(libraryStatusIsReady(status({ syncPhase: 'ready' }))).toBe(true);
  });

  it('accepts initial_sync at 95% coverage', () => {
    expect(
      libraryStatusIsReady(
        status({ syncPhase: 'initial_sync', localTrackCount: 950, serverTrackCount: 1000 }),
      ),
    ).toBe(true);
  });

  it('accepts idle after a completed full sync (legacy bind clobber)', () => {
    expect(
      libraryStatusIsReady(
        status({ syncPhase: 'idle', localTrackCount: 100, lastFullSyncAt: 1 }),
      ),
    ).toBe(true);
  });

  it('accepts idle with lastFullSyncAt even when count snapshot is stale', () => {
    expect(
      libraryStatusIsReady(
        status({ syncPhase: 'idle', localTrackCount: 0, lastFullSyncAt: 1 }),
      ),
    ).toBe(true);
  });

  it('accepts idle when tracks exist (localTracksMaxUpdatedMs)', () => {
    expect(
      libraryStatusIsReady(
        status({ syncPhase: 'idle', localTracksMaxUpdatedMs: 42 }),
      ),
    ).toBe(true);
  });

  it('accepts idle when hasLocalTracks is set', () => {
    expect(
      libraryStatusIsReady(
        status({ syncPhase: 'idle', hasLocalTracks: true, localTrackCount: 0 }),
      ),
    ).toBe(true);
  });

  it('rejects idle without a prior full sync', () => {
    expect(libraryStatusIsReady(status({ syncPhase: 'idle', localTrackCount: 0 }))).toBe(false);
  });
});

describe('syncIngestDisplayCount', () => {
  it('prefers the highest of live db count, cursor, and event total', () => {
    expect(
      syncIngestDisplayCount(
        { localTrackCount: 69_500, cursorIngestedCount: 68_000 },
        67_000,
      ),
    ).toBe(69_500);
    expect(
      syncIngestDisplayCount(
        { localTrackCount: 1_000, cursorIngestedCount: 8_000 },
        7_500,
      ),
    ).toBe(8_000);
  });
});
