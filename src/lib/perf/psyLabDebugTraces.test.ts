import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/generated/bindings', () => ({
  commands: {
    setPsylabAlbumsBrowseTrace: vi.fn(async () => ({ status: 'ok', data: null })),
    setPsylabArtistsBrowseTrace: vi.fn(async () => ({ status: 'ok', data: null })),
  },
}));

import {
  getPsyLabDebugTraces,
  isPsyLabDebugTraceEnabled,
  refreshPsyLabDebugTraceSubscribers,
  resetPsyLabDebugTraces,
  setPsyLabDebugTrace,
  setPsyLabDebugTraceOverrides,
  usePsyLabDebugTraceEnabled,
  usePsyLabDebugTraceRevision,
} from './psyLabDebugTraces';

describe('PsyLab debug trace runtime overrides', () => {
  beforeEach(async () => {
    await setPsyLabDebugTraceOverrides(null);
    resetPsyLabDebugTraces();
  });

  it('does not persist or expose benchmark overrides as user settings', async () => {
    setPsyLabDebugTrace('albumsBrowse', true);
    const persistedBefore = window.localStorage.getItem('psysonic_psylab_debug_traces_v1');

    await setPsyLabDebugTraceOverrides({ albumsBrowse: false, tracksBrowse: true });

    expect(getPsyLabDebugTraces()).toMatchObject({ albumsBrowse: true, tracksBrowse: false });
    expect(isPsyLabDebugTraceEnabled('albumsBrowse')).toBe(false);
    expect(isPsyLabDebugTraceEnabled('tracksBrowse')).toBe(true);
    expect(window.localStorage.getItem('psysonic_psylab_debug_traces_v1')).toBe(persistedBefore);

    await setPsyLabDebugTraceOverrides(null);
    expect(isPsyLabDebugTraceEnabled('albumsBrowse')).toBe(true);
    expect(isPsyLabDebugTraceEnabled('tracksBrowse')).toBe(false);
  });

  it('keeps an active runtime override when the user setting changes', async () => {
    await setPsyLabDebugTraceOverrides({ albumsBrowse: true });
    setPsyLabDebugTrace('albumsBrowse', false);

    expect(isPsyLabDebugTraceEnabled('albumsBrowse')).toBe(true);
    await setPsyLabDebugTraceOverrides(null);
    expect(isPsyLabDebugTraceEnabled('albumsBrowse')).toBe(false);
  });

  it('updates effective trace subscribers when runtime overrides change', async () => {
    const { result } = renderHook(() => usePsyLabDebugTraceEnabled('mainstage'));
    expect(result.current).toBe(false);

    await act(async () => {
      await setPsyLabDebugTraceOverrides({ mainstage: true });
    });
    expect(result.current).toBe(true);
    expect(getPsyLabDebugTraces().mainstage).toBe(false);

    await act(async () => {
      await setPsyLabDebugTraceOverrides(null);
    });
    expect(result.current).toBe(false);
  });

  it('can explicitly replay diagnostics after a benchmark store reset', () => {
    const { result } = renderHook(() => usePsyLabDebugTraceRevision());
    const before = result.current;

    act(() => refreshPsyLabDebugTraceSubscribers());

    expect(result.current).toBe(before + 1);
  });
});
