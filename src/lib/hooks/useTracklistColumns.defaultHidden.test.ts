import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTracklistColumns, type ColDef } from '@/lib/hooks/useTracklistColumns';

const KEY = 'psysonic_test_columns';

const COLUMNS: readonly ColDef[] = [
  { key: 'num',    i18nKey: null,       minWidth: 60, defaultWidth: 60,  required: true },
  { key: 'title',  i18nKey: 'trackTitle', minWidth: 120, defaultWidth: 300, required: true },
  { key: 'album',  i18nKey: 'trackAlbum', minWidth: 80, defaultWidth: 200, required: false },
  { key: 'bpm',    i18nKey: 'trackBpm',   minWidth: 50, defaultWidth: 70,  required: false, defaultHidden: true },
];

const visibleKeys = (result: { current: ReturnType<typeof useTracklistColumns> }) =>
  result.current.visibleCols.map(c => c.key);

describe('useTracklistColumns — defaultHidden', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // A list may offer more columns than fit on screen at once; without this the
  // opening view runs past the page's right edge.
  it('leaves a defaultHidden column out of the first render', () => {
    const { result } = renderHook(() => useTracklistColumns(COLUMNS, KEY));
    expect(visibleKeys(result)).toEqual(['num', 'title', 'album']);
  });

  it('still offers the column, so the picker can turn it on', () => {
    const { result } = renderHook(() => useTracklistColumns(COLUMNS, KEY));
    expect(result.current.colVisible.has('bpm')).toBe(false);
    expect(COLUMNS.some(c => c.key === 'bpm')).toBe(true);
  });

  it('honours a stored choice to show it', () => {
    localStorage.setItem(KEY, JSON.stringify({ visible: ['num', 'title', 'album', 'bpm'] }));
    const { result } = renderHook(() => useTracklistColumns(COLUMNS, KEY));
    expect(visibleKeys(result)).toContain('bpm');
  });

  // Columns added after prefs were saved auto-appear — but one that ships hidden
  // must not, or every existing user would get it switched on by the upgrade.
  it('does not auto-show a hidden column that is new since the prefs were saved', () => {
    localStorage.setItem(KEY, JSON.stringify({
      visible: ['num', 'title', 'album'],
      known: ['num', 'title', 'album'],
    }));
    const { result } = renderHook(() => useTracklistColumns(COLUMNS, KEY));
    expect(visibleKeys(result)).not.toContain('bpm');
  });

  // "Reset" has to land on the same view a fresh install gets. Turning every
  // column on would overflow the very table the flag exists to keep in bounds,
  // and the user would have to switch eight of them off by hand.
  it('keeps a hidden column off when the columns are reset', () => {
    localStorage.setItem(KEY, JSON.stringify({ visible: ['num', 'title', 'album', 'bpm'] }));
    const { result } = renderHook(() => useTracklistColumns(COLUMNS, KEY));
    expect(visibleKeys(result)).toContain('bpm');

    act(() => result.current.resetColumns());
    expect(visibleKeys(result)).toEqual(['num', 'title', 'album']);
  });

  it('still auto-shows a new column that ships visible', () => {
    localStorage.setItem(KEY, JSON.stringify({
      visible: ['num', 'title'],
      known: ['num', 'title'],
    }));
    const { result } = renderHook(() => useTracklistColumns(COLUMNS, KEY));
    expect(visibleKeys(result)).toContain('album');
  });
});
