/**
 * The genre selection is an effect dependency of the pages that use this hook,
 * and each of their loads is a query on the one shared browse connection. A
 * reset that hands out a fresh `[]` when the selection was already empty is
 * therefore not free: it re-runs those loads for no change in state.
 *
 * The navigation type is mocked to `PUSH` on purpose. Under the default `POP`
 * the hook takes its session-restore branch and returns before the reset ever
 * runs — a test left on the default passes without touching the code it claims
 * to cover.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Only the two entry points the hook reads are overridden; everything else in
// the router keeps working. Replacing the whole module would make this test
// break on an unrelated import somewhere in the hook's dependency chain.
vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigationType: () => 'PUSH',
  useLocation: () => ({ pathname: '/new-releases', state: null }),
}));

import { useAlbumGridBrowseFilters } from '@/features/album/hooks/useAlbumGridBrowseFilters';

describe('useAlbumGridBrowseFilters', () => {
  it('keeps the same empty selection when the reset effect re-runs', () => {
    const view = renderHook(
      ({ serverId }) => useAlbumGridBrowseFilters(serverId, 'new-releases'),
      { initialProps: { serverId: 'server-a' } },
    );

    const first = view.result.current.selectedGenres;
    expect(first).toEqual([]);

    // `serverId` is a dependency of the reset effect, so this re-runs it. The
    // selection is already empty, so consumers must not see a new array.
    view.rerender({ serverId: 'server-b' });

    expect(view.result.current.selectedGenres).toBe(first);
  });

  it('still clears a selection that is not empty', () => {
    const view = renderHook(
      ({ serverId }) => useAlbumGridBrowseFilters(serverId, 'new-releases'),
      { initialProps: { serverId: 'server-a' } },
    );

    act(() => { view.result.current.setSelectedGenres(['metal']); });
    expect(view.result.current.selectedGenres).toEqual(['metal']);

    view.rerender({ serverId: 'server-b' });

    expect(view.result.current.selectedGenres).toEqual([]);
  });
});
