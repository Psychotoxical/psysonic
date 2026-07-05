// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAlbumDetailBack } from '@/features/album/hooks/useAlbumDetailBack';
import { navigateAlbumDetailBack } from '@/lib/navigation/albumDetailNavigation';

vi.mock('@/lib/navigation/albumDetailNavigation', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/navigation/albumDetailNavigation')>();
  return {
    ...mod,
    navigateAlbumDetailBack: vi.fn(mod.navigateAlbumDetailBack),
  };
});

function detailWrapper(initialState: unknown) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[{ pathname: '/album/al-1', state: initialState }]}>
        <Routes>
          <Route path="/album/:id" element={children} />
        </Routes>
      </MemoryRouter>
    );
  };
}

describe('useAlbumDetailBack', () => {
  beforeEach(() => {
    vi.mocked(navigateAlbumDetailBack).mockClear();
  });

  it('routes browser back through navigateAlbumDetailBack when returnTo exists', () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    renderHook(() => useAlbumDetailBack(), {
      wrapper: detailWrapper({ returnTo: '/search/advanced' }),
    });

    expect(pushStateSpy).toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(navigateAlbumDetailBack).toHaveBeenCalledTimes(1);
    pushStateSpy.mockRestore();
  });

  it('does not trap browser back when returnTo is missing', () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    renderHook(() => useAlbumDetailBack(), {
      wrapper: detailWrapper(null),
    });

    expect(pushStateSpy).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(navigateAlbumDetailBack).not.toHaveBeenCalled();
    pushStateSpy.mockRestore();
  });
});
