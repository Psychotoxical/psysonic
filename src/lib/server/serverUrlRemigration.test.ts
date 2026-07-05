import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri core invoke surface — the orchestrator calls
// `migration_inspect`, `migration_run`, and `cover_cache_rename_server_bucket`
// through this single entry point.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  indexKeyRemapForUrlChange,
  runIndexKeyRemigration,
} from '@/lib/server/serverUrlRemigration';

function inspectStub(needs = true) {
  return {
    needsMigration: needs,
    hasSkippedUnknownServerRows: false,
    canRun: true,
    warnings: [],
    unmappedEmptyBucket: false,
    library: { totalLegacyRows: 100, skippedUnknownServerRows: 0, tables: {} },
    analysis: { totalLegacyRows: 50, skippedUnknownServerRows: 0, tables: {} },
    mappings: [{ legacyId: 'old.example.com', indexKey: 'new.example.com' }],
  };
}

function runStub() {
  return {
    library: { importedRows: 100, sourceRows: 100, skippedUnknownServerRows: 0 },
    analysis: { importedRows: 50, sourceRows: 50, skippedUnknownServerRows: 0 },
    hasSkippedUnknownServerRows: false,
    switched: true,
    backupRemoved: true,
  };
}

describe('indexKeyRemapForUrlChange', () => {
  it('returns null when both urls collapse to the same index key', () => {
    expect(
      indexKeyRemapForUrlChange({ url: 'https://music.example.com' }, { url: 'http://music.example.com/' }),
    ).toBeNull();
  });

  it('returns null when only the scheme changes', () => {
    expect(
      indexKeyRemapForUrlChange({ url: 'http://music.example.com' }, { url: 'https://music.example.com' }),
    ).toBeNull();
  });

  it('returns null for missing urls', () => {
    expect(indexKeyRemapForUrlChange({ url: '' }, { url: 'https://x.example' })).toBeNull();
    expect(indexKeyRemapForUrlChange({ url: 'https://x.example' }, { url: '' })).toBeNull();
  });

  it('returns the remap when the host changes', () => {
    expect(
      indexKeyRemapForUrlChange(
        { url: 'https://old.example.com' },
        { url: 'https://new.example.com' },
      ),
    ).toEqual({ oldKey: 'old.example.com', newKey: 'new.example.com' });
  });

  it('returns the remap when the path part changes', () => {
    expect(
      indexKeyRemapForUrlChange(
        { url: 'https://music.example.com' },
        { url: 'https://music.example.com/navidrome' },
      ),
    ).toEqual({ oldKey: 'music.example.com', newKey: 'music.example.com/navidrome' });
  });
});

describe('runIndexKeyRemigration', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('runs the full pipeline on the happy path', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(inspectStub()) // migration_inspect
      .mockResolvedValueOnce(runStub())     // migration_run
      .mockResolvedValueOnce(undefined);     // cover_cache_rename_server_bucket

    const result = await runIndexKeyRemigration({ oldKey: 'old', newKey: 'new' });

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(vi.mocked(invoke).mock.calls[0]![0]).toBe('migration_inspect');
    expect(vi.mocked(invoke).mock.calls[1]![0]).toBe('migration_run');
    expect(vi.mocked(invoke).mock.calls[2]![0]).toBe('cover_cache_rename_server_bucket');
    expect(vi.mocked(invoke).mock.calls[2]![1]).toEqual({ oldKey: 'old', newKey: 'new' });
  });

  it('hands the same { legacyId, indexKey } mapping to inspect + run', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(inspectStub())
      .mockResolvedValueOnce(runStub())
      .mockResolvedValueOnce(undefined);

    await runIndexKeyRemigration({ oldKey: 'old.example.com', newKey: 'new.example.com' });

    const inspectCall = vi.mocked(invoke).mock.calls[0]!;
    const runCall = vi.mocked(invoke).mock.calls[1]!;
    expect(inspectCall[1]).toEqual({
      mappings: [{ legacyId: 'old.example.com', indexKey: 'new.example.com' }],
    });
    expect(runCall[1]).toEqual({
      mappings: [{ legacyId: 'old.example.com', indexKey: 'new.example.com' }],
    });
  });

  it('reports inspect failure and stops without running the destructive step', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('locked')); // inspect throws

    const result = await runIndexKeyRemigration({ oldKey: 'old', newKey: 'new' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.stage).toBe('inspect');
      expect(result.failure.error).toContain('locked');
    }
    expect(invoke).toHaveBeenCalledTimes(1); // only inspect ran
  });

  it('reports run failure and does not attempt the cover rename', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(inspectStub())
      .mockRejectedValueOnce(new Error('disk full'));

    const result = await runIndexKeyRemigration({ oldKey: 'old', newKey: 'new' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.stage).toBe('run');
    expect(invoke).toHaveBeenCalledTimes(2); // inspect + failed run
  });

  it('reports cover-rename failure (DB rows already moved — recoverable)', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(inspectStub())
      .mockResolvedValueOnce(runStub())
      .mockRejectedValueOnce(new Error('rename: permission denied'));

    const result = await runIndexKeyRemigration({ oldKey: 'old', newKey: 'new' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.stage).toBe('cover-rename');
      expect(result.failure.error).toContain('permission denied');
    }
    expect(invoke).toHaveBeenCalledTimes(3); // all three were attempted
  });
});
