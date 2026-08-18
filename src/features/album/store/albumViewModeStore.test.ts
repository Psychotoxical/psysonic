import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ALBUM_VIEW_MODE,
  sanitizeAlbumViewModes,
  useAlbumViewModeStore,
} from './albumViewModeStore';

const STORAGE_KEY = 'psysonic_album_view_mode';

function seedPersisted(modeBySurface: unknown): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ state: { modeBySurface }, version: 1 }),
  );
}

describe('sanitizeAlbumViewModes', () => {
  it('keeps known surfaces with known modes', () => {
    expect(sanitizeAlbumViewModes({ albums: 'table', lossless: 'grid' })).toEqual({
      albums: 'table',
      lossless: 'grid',
    });
  });

  // Persisted state outlives the code that wrote it. A mode string that no
  // longer exists must not reach the page — it would match neither branch of
  // the grid/table switch and render nothing at all.
  it('drops unknown modes and unknown surfaces', () => {
    expect(
      sanitizeAlbumViewModes({ albums: 'carousel', 'random-albums': 'table', 'new-releases': 'grid' }),
    ).toEqual({ 'new-releases': 'grid' });
  });

  it('returns an empty record for anything that is not an object', () => {
    expect(sanitizeAlbumViewModes(null)).toEqual({});
    expect(sanitizeAlbumViewModes('table')).toEqual({});
    expect(sanitizeAlbumViewModes(undefined)).toEqual({});
  });
});

describe('useAlbumViewModeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useAlbumViewModeStore.setState({ modeBySurface: {} });
  });

  it('remembers each page separately', () => {
    const { setViewMode } = useAlbumViewModeStore.getState();
    setViewMode('albums', 'table');
    setViewMode('lossless', 'grid');

    const { modeBySurface } = useAlbumViewModeStore.getState();
    expect(modeBySurface.albums).toBe('table');
    expect(modeBySurface.lossless).toBe('grid');
    expect(modeBySurface['new-releases']).toBeUndefined();
  });

  it('falls back to the grid for a page that was never switched', () => {
    expect(
      useAlbumViewModeStore.getState().modeBySurface['new-releases'] ?? DEFAULT_ALBUM_VIEW_MODE,
    ).toBe('grid');
  });

  it('rehydrates a stored mode', async () => {
    seedPersisted({ albums: 'table' });
    await useAlbumViewModeStore.persist.rehydrate();
    expect(useAlbumViewModeStore.getState().modeBySurface.albums).toBe('table');
  });

  it('sanitises damaged persisted state on rehydrate', async () => {
    seedPersisted({ albums: 'nonsense', lossless: 'table' });
    await useAlbumViewModeStore.persist.rehydrate();

    const { modeBySurface } = useAlbumViewModeStore.getState();
    expect(modeBySurface.albums).toBeUndefined();
    expect(modeBySurface.lossless).toBe('table');
    // The setter has to survive a merge that replaced the whole slice.
    expect(typeof useAlbumViewModeStore.getState().setViewMode).toBe('function');
  });
});
