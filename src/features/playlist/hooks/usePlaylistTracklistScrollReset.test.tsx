import { StrictMode } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { usePlaylistTracklistScrollReset } from './usePlaylistTracklistScrollReset';

describe('usePlaylistTracklistScrollReset', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('preserves restored scroll through StrictMode effect replay', () => {
    const viewport = document.createElement('div');
    viewport.id = APP_MAIN_SCROLL_VIEWPORT_ID;
    viewport.scrollTop = 864;
    document.body.appendChild(viewport);

    const { rerender } = renderHook(
      ({ hasActiveFilter }) => usePlaylistTracklistScrollReset({
        id: 'pl-1',
        hasActiveFilter,
        scrollMargin: 120,
      }),
      {
        initialProps: { hasActiveFilter: false },
        wrapper: StrictMode,
      },
    );

    expect(viewport.scrollTop).toBe(864);

    rerender({ hasActiveFilter: true });
    expect(viewport.scrollTop).toBe(120);
  });
});
