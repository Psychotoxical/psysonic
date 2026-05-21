import { describe, expect, it } from 'vitest';
import {
  decodeCapabilityFlags,
  explainLibraryReady,
  formatLibrarySearchLine,
  ingestStallHint,
  normalizeIngestMetrics,
} from './libraryDevLog';
import type { SyncStateDto } from '../../api/library';

describe('libraryDevLog', () => {
  it('decodeCapabilityFlags maps known bits', () => {
    expect(decodeCapabilityFlags(0x003)).toEqual([
      'navidromeNativeBulk(N1)',
      'subsonicSearch3Bulk(S1)',
    ]);
    expect(decodeCapabilityFlags(0)).toEqual(['none']);
  });

  it('explainLibraryReady covers ready and idle paths', () => {
    expect(explainLibraryReady({ syncPhase: 'ready' } as SyncStateDto)).toBe('syncPhase=ready');
    expect(
      explainLibraryReady({
        syncPhase: 'initial_sync',
        localTrackCount: 950,
        serverTrackCount: 1000,
      } as SyncStateDto),
    ).toContain('≥95%');
    expect(
      explainLibraryReady({
        syncPhase: 'initial_sync',
        cursorIngestedCount: 68000,
        localTrackCount: 69500,
        serverTrackCount: 170148,
      } as SyncStateDto),
    ).toContain('69500/170148');
    expect(
      explainLibraryReady({
        syncPhase: 'idle',
        hasLocalTracks: true,
      } as SyncStateDto),
    ).toBe('idle + hasLocalTracks');
  });

  it('normalizeIngestMetrics accepts camelCase and snake_case', () => {
    expect(
      normalizeIngestMetrics({
        offset: 4000,
        fetchMs: 9000,
        lockWaitMs: 8500,
        writeMs: 8510,
        sqlExecMs: 10,
        persistMs: 0,
        rowCount: 500,
        bulkIngestActive: true,
        strategy: 's1',
      }),
    ).toMatchObject({ fetchMs: 9000, lockWaitMs: 8500 });
    expect(
      normalizeIngestMetrics({
        offset: 4000,
        fetch_ms: 9000,
        lock_wait_ms: 8500,
        write_ms: 8510,
        sql_exec_ms: 10,
        persist_ms: 0,
        row_count: 500,
        bulk_ingest_active: true,
        strategy: 's1',
      }),
    ).toMatchObject({ fetchMs: 9000, lockWaitMs: 8500 });
  });

  it('ingestStallHint flags lock wait vs fetch vs sql', () => {
    expect(
      ingestStallHint({
        offset: 60500,
        strategy: 's1',
        fetchMs: 200,
        writeMs: 61319,
        lockWaitMs: 61308,
        sqlExecMs: 11,
        persistMs: 0,
        rowCount: 500,
        bulkIngestActive: true,
      }),
    ).toBe('write_lock_held_by_other_op');
  });

  it('formatLibrarySearchLine uses unified search prefix', () => {
    expect(
      formatLibrarySearchLine({
        at: '',
        query: 'foo',
        path: 'search_race',
        surface: 'live_search',
        durationMs: 14,
        raceWinner: 'local',
        raceWinnerMs: 9,
        counts: { artists: 1, albums: 2, songs: 3 },
      }),
    ).toBe(
      'search [live_search] path=search_race winner=local raceMs=9 totalMs=14 hits=1/2/3',
    );
    expect(
      formatLibrarySearchLine({
        at: '',
        query: 'bar',
        path: 'search3',
        surface: 'advanced_search',
        source: 'network',
        durationMs: 120,
        invokeMs: 80,
      }),
    ).toBe(
      'search [advanced_search] path=search3 source=network totalMs=120 invokeMs=80',
    );
  });
});
