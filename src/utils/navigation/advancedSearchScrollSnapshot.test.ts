// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAdvancedSearchAlbumRowScrollSnapshots,
  peekPersistedAdvancedSearchAlbumRowScrollLeft,
  persistAdvancedSearchAlbumRowScrollLeft,
  readAdvancedSearchAlbumRowScrollLeft,
  registerAdvancedSearchAlbumRowScrollProvider,
  resolveAdvancedSearchAlbumRowScrollLeft,
  saveAdvancedSearchAlbumRowScrollOnLeave,
} from './advancedSearchScrollSnapshot';
import { useAdvancedSearchSessionStore } from '../../store/advancedSearchSessionStore';

describe('advancedSearchScrollSnapshot', () => {
  afterEach(() => {
    clearAdvancedSearchAlbumRowScrollSnapshots();
    useAdvancedSearchSessionStore.getState().clearReturnStash();
    sessionStorage.clear();
    document.body.innerHTML = '';
  });

  it('persists and peeks album-row scrollLeft in sessionStorage', () => {
    persistAdvancedSearchAlbumRowScrollLeft(120);
    expect(peekPersistedAdvancedSearchAlbumRowScrollLeft()).toBe(120);
  });

  it('reads leave snapshot from registered provider merged with DOM', () => {
    const albumGrid = document.createElement('div');
    albumGrid.className = 'album-grid';
    Object.defineProperty(albumGrid, 'scrollLeft', { value: 80, writable: true });
    const row = document.createElement('div');
    row.setAttribute('data-advanced-search-album-row', '');
    row.appendChild(albumGrid);
    document.body.appendChild(row);

    const unregister = registerAdvancedSearchAlbumRowScrollProvider(() => 45);
    expect(readAdvancedSearchAlbumRowScrollLeft()).toBe(80);
    unregister();
  });

  it('merges leave value, sessionStorage, and stash scrollLeft', () => {
    useAdvancedSearchSessionStore.getState().setLeaveAlbumRowScrollLeft(300);
    persistAdvancedSearchAlbumRowScrollLeft(80);
    expect(resolveAdvancedSearchAlbumRowScrollLeft({
      query: '',
      genre: '',
      yearFrom: '',
      yearTo: '',
      bpmFrom: '',
      bpmTo: '',
      moodGroup: '',
      losslessOnly: false,
      resultType: 'all',
      starredOnly: false,
      results: null,
      hasSearched: false,
      activeSearch: null,
      localMode: false,
      songsServerOffset: 0,
      songsHasMore: false,
      genreNote: false,
      albumRowScrollLeft: 20,
    })).toBe(300);
  });

  it('saves album-row scrollLeft to zustand and sessionStorage on leave', () => {
    const albumGrid = document.createElement('div');
    albumGrid.className = 'album-grid';
    Object.defineProperty(albumGrid, 'scrollLeft', { value: 160, writable: true });
    const row = document.createElement('div');
    row.setAttribute('data-advanced-search-album-row', '');
    row.appendChild(albumGrid);
    document.body.appendChild(row);

    expect(saveAdvancedSearchAlbumRowScrollOnLeave()).toBe(160);
    expect(useAdvancedSearchSessionStore.getState().peekLeaveAlbumRowScrollLeft()).toBe(160);
    expect(peekPersistedAdvancedSearchAlbumRowScrollLeft()).toBe(160);
  });
});
