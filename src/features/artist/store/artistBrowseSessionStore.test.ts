import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_ARTIST_BROWSE_RETURN_STATE,
  peekArtistBrowseScrollRestore,
  useArtistBrowseSessionStore,
} from '@/features/artist/store/artistBrowseSessionStore';

describe('artistBrowseSessionStore', () => {
  beforeEach(() => {
    useArtistBrowseSessionStore.setState({ returnStashByServer: {} });
  });

  it('stashes and peeks return state per server', () => {
    const { stashReturnState, peekReturnStash } = useArtistBrowseSessionStore.getState();
    stashReturnState('s1', {
      ...DEFAULT_ARTIST_BROWSE_RETURN_STATE,
      filter: 'mozart',
      letterFilter: 'M',
      viewMode: 'list',
      scrollTop: 240,
      visibleCount: 120,
    });
    expect(peekReturnStash('s1')).toEqual({
      filter: 'mozart',
      letterFilter: 'M',
      starredOnly: false,
      creditMode: 'album',
      viewMode: 'list',
      showArtistImages: true,
      scrollTop: 240,
      visibleCount: 120,
    });
  });

  it('clears return stash for a server', () => {
    const { stashReturnState, clearReturnStash, peekReturnStash } = useArtistBrowseSessionStore.getState();
    stashReturnState('s1', DEFAULT_ARTIST_BROWSE_RETURN_STATE);
    clearReturnStash('s1');
    expect(peekReturnStash('s1')).toBeNull();
  });

  it('exposes scroll restore target when scroll fields are present', () => {
    useArtistBrowseSessionStore.getState().stashReturnState('s1', {
      ...DEFAULT_ARTIST_BROWSE_RETURN_STATE,
      scrollTop: 512,
      visibleCount: 80,
    });
    expect(peekArtistBrowseScrollRestore('s1')).toEqual({ scrollTop: 512, visibleCount: 80 });
  });
});
