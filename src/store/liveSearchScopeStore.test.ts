import { describe, expect, it, beforeEach } from 'vitest';
import {
  scopedBrowseSearchQuery,
  useLiveSearchScopeStore,
} from './liveSearchScopeStore';

describe('liveSearchScopeStore', () => {
  beforeEach(() => {
    useLiveSearchScopeStore.setState({ query: '', scope: null, undoStack: [] });
  });

  it('returns browse query only when the expected scope is active', () => {
    useLiveSearchScopeStore.setState({ query: 'beatles', scope: 'artists' });
    expect(scopedBrowseSearchQuery('beatles', 'artists', 'artists')).toBe('beatles');
    expect(scopedBrowseSearchQuery('beatles', null, 'artists')).toBe('');
    useLiveSearchScopeStore.setState({ query: 'abbey', scope: 'albums' });
    expect(scopedBrowseSearchQuery('abbey', 'albums', 'albums')).toBe('abbey');
    expect(scopedBrowseSearchQuery('abbey', 'artists', 'albums')).toBe('');
    useLiveSearchScopeStore.setState({ query: 'jazz', scope: 'newReleases' });
    expect(scopedBrowseSearchQuery('jazz', 'newReleases', 'newReleases')).toBe('jazz');
    useLiveSearchScopeStore.setState({ query: 'track', scope: 'tracks' });
    expect(scopedBrowseSearchQuery('track', 'tracks', 'tracks')).toBe('track');
    expect(scopedBrowseSearchQuery('track', 'albums', 'tracks')).toBe('');
    useLiveSearchScopeStore.setState({ query: 'bach', scope: 'composers' });
    expect(scopedBrowseSearchQuery('bach', 'composers', 'composers')).toBe('bach');
    expect(scopedBrowseSearchQuery('bach', 'artists', 'composers')).toBe('');
    useLiveSearchScopeStore.setState({ query: 'road', scope: 'playlists' });
    expect(scopedBrowseSearchQuery('road', 'playlists', 'playlists')).toBe('road');
    expect(scopedBrowseSearchQuery('road', 'albums', 'playlists')).toBe('');
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
