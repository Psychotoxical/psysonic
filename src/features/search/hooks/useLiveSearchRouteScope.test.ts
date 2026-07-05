import { describe, expect, it, beforeEach } from 'vitest';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';
import { syncLiveSearchRouteScope } from '@/features/search/hooks/useLiveSearchRouteScope';

describe('syncLiveSearchRouteScope', () => {
  beforeEach(() => {
    useLiveSearchScopeStore.setState({ query: '', scope: null, undoStack: [] });
  });

  it('activates scope on supported browse routes', () => {
    syncLiveSearchRouteScope('/albums');
    expect(useLiveSearchScopeStore.getState().scope).toBe('albums');

    syncLiveSearchRouteScope('/tracks');
    expect(useLiveSearchScopeStore.getState().scope).toBe('tracks');

    syncLiveSearchRouteScope('/composers');
    expect(useLiveSearchScopeStore.getState().scope).toBe('composers');
  });

  it('clears scope and query when leaving browse routes', () => {
    useLiveSearchScopeStore.setState({ query: 'beatles', scope: 'albums' });

    syncLiveSearchRouteScope('/album/abc123');

    expect(useLiveSearchScopeStore.getState().scope).toBeNull();
    expect(useLiveSearchScopeStore.getState().query).toBe('');
  });

  it('clears query when leaving browse with scope already cleared (ghost mode)', () => {
    useLiveSearchScopeStore.setState({ query: 'beatles', scope: null });

    syncLiveSearchRouteScope('/album/abc123');

    expect(useLiveSearchScopeStore.getState().scope).toBeNull();
    expect(useLiveSearchScopeStore.getState().query).toBe('');
  });

  it('preserves query when switching between browse routes', () => {
    useLiveSearchScopeStore.setState({ query: 'jazz', scope: 'albums' });

    syncLiveSearchRouteScope('/artists');

    expect(useLiveSearchScopeStore.getState().scope).toBe('artists');
    expect(useLiveSearchScopeStore.getState().query).toBe('jazz');
  });
});
