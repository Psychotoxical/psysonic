import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWhatsNewAsset = vi.fn();
const readReleaseNotesCache = vi.fn();
const writeReleaseNotesCache = vi.fn();

vi.mock('@/features/whatsNew/utils/releaseNotesChannel', () => ({
  isDevChannelVersion: (version: string) => /-dev(?:\b|$)/i.test(version.trim()),
  isWorkspaceReleaseNotesMode: (version: string) => /-dev(?:\b|$)/i.test(version.trim()),
}));

vi.mock('@/features/whatsNew/utils/releaseNotesFetch', () => ({
  fetchWhatsNewAsset: (...args: unknown[]) => fetchWhatsNewAsset(...args),
}));

vi.mock('@/features/whatsNew/utils/releaseNotesCache', () => ({
  readReleaseNotesCache: (...args: unknown[]) => readReleaseNotesCache(...args),
  writeReleaseNotesCache: (...args: unknown[]) => writeReleaseNotesCache(...args),
}));

vi.mock('@/generated/releaseNotesBundle', () => ({
  WHATS_NEW_RAW: `## [1.48.0] - 2026-06-10

## Highlights
- Embedded what's new`,
  CHANGELOG_RAW: `## [1.48.0]

## Added
- Embedded changelog fallback`,
}));

const { resolveReleaseNotes } = await import('@/features/whatsNew/utils/releaseNotesResolve');

describe('resolveReleaseNotes (shipped channel)', () => {
  beforeEach(() => {
    fetchWhatsNewAsset.mockReset();
    readReleaseNotesCache.mockReset();
    writeReleaseNotesCache.mockReset();
    readReleaseNotesCache.mockResolvedValue(null);
    fetchWhatsNewAsset.mockResolvedValue(null);
  });

  it('uses cache before network', async () => {
    readReleaseNotesCache.mockResolvedValue('Cached body line');

    const r = await resolveReleaseNotes('1.48.0');
    expect(r.source).toBe('cache');
    expect(r.entry?.body).toContain('Cached body line');
    expect(fetchWhatsNewAsset).not.toHaveBeenCalled();
  });

  it('fetches remote and writes cache when no cache hit', async () => {
    fetchWhatsNewAsset.mockResolvedValue('Fresh remote body');

    const r = await resolveReleaseNotes('1.48.0-rc.1');
    expect(r.source).toBe('remote');
    expect(r.entry?.body).toBe('Fresh remote body');
    expect(writeReleaseNotesCache).toHaveBeenCalledWith('1.48.0-rc.1', 'Fresh remote body');
  });

  it('falls back to embedded whats-new when offline', async () => {
    const r = await resolveReleaseNotes('1.48.0');
    expect(r.source).toBe('embedded-whats-new');
    expect(r.entry?.body).toContain("Embedded what's new");
    expect(r.entry?.date).toBe('2026-06-10');
  });
});

describe('resolveReleaseNotes (workspace)', () => {
  beforeEach(() => {
    fetchWhatsNewAsset.mockReset();
    readReleaseNotesCache.mockReset();
  });

  it('skips fetch for -dev versions', async () => {
    const r = await resolveReleaseNotes('1.48.0-dev');
    expect(['workspace', 'workspace-changelog']).toContain(r.source);
    expect(fetchWhatsNewAsset).not.toHaveBeenCalled();
    expect(r.entry?.body.length).toBeGreaterThan(0);
  });
});
