import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_ARTIST_ALBUM_YEAR_ORDER,
  useArtistAlbumYearSortStore,
} from '@/features/artist/store/artistAlbumYearSortStore';

describe('artistAlbumYearSortStore', () => {
  beforeEach(() => {
    useArtistAlbumYearSortStore.setState({ orderByServer: {} });
  });

  it('defaults to newest first per server', () => {
    expect(useArtistAlbumYearSortStore.getState().yearOrderFor('s1')).toBe(
      DEFAULT_ARTIST_ALBUM_YEAR_ORDER,
    );
  });

  it('toggles between newest and oldest for the same server', () => {
    const { toggleYearOrder, yearOrderFor } = useArtistAlbumYearSortStore.getState();
    toggleYearOrder('s1');
    expect(yearOrderFor('s1')).toBe('yearAsc');
    toggleYearOrder('s1');
    expect(yearOrderFor('s1')).toBe('yearDesc');
  });

  it('keeps order per server independently', () => {
    const { toggleYearOrder, yearOrderFor } = useArtistAlbumYearSortStore.getState();
    toggleYearOrder('s1');
    expect(yearOrderFor('s1')).toBe('yearAsc');
    expect(yearOrderFor('s2')).toBe('yearDesc');
  });
});
