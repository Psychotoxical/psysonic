import { describe, expect, it, beforeEach } from 'vitest';
import {
  artistsBrowseSearchQuery,
  useLiveSearchScopeStore,
} from './liveSearchScopeStore';

describe('liveSearchScopeStore', () => {
  beforeEach(() => {
    useLiveSearchScopeStore.setState({ query: '', scope: null, undoStack: [] });
  });

  it('returns browse query only when artists scope is active', () => {
    useLiveSearchScopeStore.setState({ query: 'beatles', scope: 'artists' });
    expect(artistsBrowseSearchQuery('beatles', 'artists')).toBe('beatles');
    expect(artistsBrowseSearchQuery('beatles', null)).toBe('');
  });

  it('undoes query and scope badge changes', () => {
    useLiveSearchScopeStore.getState().setScope('artists');
    useLiveSearchScopeStore.getState().setQuery('ab', { recordUndo: true });
    useLiveSearchScopeStore.getState().setQuery('a', { recordUndo: true });
    useLiveSearchScopeStore.getState().clearScope({ recordUndo: true });

    expect(useLiveSearchScopeStore.getState().scope).toBeNull();
    expect(useLiveSearchScopeStore.getState().undo()).toBe(true);
    expect(useLiveSearchScopeStore.getState().scope).toBe('artists');
    expect(useLiveSearchScopeStore.getState().query).toBe('a');
    expect(useLiveSearchScopeStore.getState().undo()).toBe(true);
    expect(useLiveSearchScopeStore.getState().query).toBe('ab');
  });

  it('does not record undo for programmatic setQuery by default', () => {
    useLiveSearchScopeStore.getState().setQuery('test');
    expect(useLiveSearchScopeStore.getState().undo()).toBe(false);
  });
});
