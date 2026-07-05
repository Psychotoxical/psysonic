// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import {
  clearAdvancedSearchLeaveSnapshots,
  peekPersistedAdvancedSearchLeaveSnapshot,
  readAdvancedSearchLeaveSnapshot,
  registerAdvancedSearchLeaveScrollProvider,
  registerAdvancedSearchSessionProvider,
  resolveAdvancedSearchLeaveSnapshot,
  saveAdvancedSearchLeaveSnapshot,
} from '@/lib/navigation/advancedSearchScrollSnapshot';
import { useAdvancedSearchSessionStore } from '@/store/advancedSearchSessionStore';

describe('advancedSearchScrollSnapshot', () => {
  afterEach(() => {
    clearAdvancedSearchLeaveSnapshots();
    useAdvancedSearchSessionStore.getState().clearReturnStash();
    sessionStorage.clear();
    document.body.innerHTML = '';
  });

  it('persists and peeks leave snapshot in sessionStorage', () => {
    const viewport = document.createElement('div');
    viewport.id = APP_MAIN_SCROLL_VIEWPORT_ID;
    Object.defineProperty(viewport, 'scrollTop', { value: 640, writable: true });
    document.body.appendChild(viewport);

    saveAdvancedSearchLeaveSnapshot();
    expect(peekPersistedAdvancedSearchLeaveSnapshot()).toEqual({
      scrollTop: 640,
      albumRowScrollLeft: 0,
      artistRowScrollLeft: 0,
    });
  });

  it('reads leave snapshot from provider merged with DOM', () => {
    const viewport = document.createElement('div');
    viewport.id = APP_MAIN_SCROLL_VIEWPORT_ID;
    Object.defineProperty(viewport, 'scrollTop', { value: 512, writable: true });
    document.body.appendChild(viewport);

    const albumGrid = document.createElement('div');
    albumGrid.className = 'album-grid';
    Object.defineProperty(albumGrid, 'scrollLeft', { value: 80, writable: true });
    const row = document.createElement('div');
    row.setAttribute('data-advanced-search-album-row', '');
    row.appendChild(albumGrid);
    document.body.appendChild(row);

    const unregister = registerAdvancedSearchLeaveScrollProvider(() => ({
      scrollTop: 100,
      albumRowScrollLeft: 45,
      artistRowScrollLeft: 10,
    }));
    expect(readAdvancedSearchLeaveSnapshot()).toEqual({
      scrollTop: 512,
      albumRowScrollLeft: 80,
      artistRowScrollLeft: 10,
    });
    unregister();
  });

  it('reads artist row scroll from DOM', () => {
    const artistGrid = document.createElement('div');
    artistGrid.className = 'album-grid';
    Object.defineProperty(artistGrid, 'scrollLeft', { value: 120, writable: true });
    const row = document.createElement('div');
    row.setAttribute('data-advanced-search-artist-row', '');
    row.appendChild(artistGrid);
    document.body.appendChild(row);

    expect(readAdvancedSearchLeaveSnapshot()).toEqual({
      scrollTop: 0,
      albumRowScrollLeft: 0,
      artistRowScrollLeft: 120,
    });
  });

  it('merges leave snapshot, sessionStorage, and stash scroll fields', () => {
    useAdvancedSearchSessionStore.getState().setLeaveScrollSnapshot({
      scrollTop: 300,
      albumRowScrollLeft: 0,
      artistRowScrollLeft: 0,
    });
    sessionStorage.setItem(
      'psysonic:advanced-search-leave-v1',
      JSON.stringify({ scrollTop: 100, albumRowScrollLeft: 80, artistRowScrollLeft: 55 }),
    );
    expect(resolveAdvancedSearchLeaveSnapshot({
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
      basicSearchMode: false,
      tracksBrowseMode: false,
      tracksBrowseUnsupported: false,
      scrollTop: 50,
      albumRowScrollLeft: 20,
      artistRowScrollLeft: 15,
    })).toEqual({ scrollTop: 300, albumRowScrollLeft: 80, artistRowScrollLeft: 55 });
  });

  it('saves session stash together with leave snapshot on navigate away', () => {
    const viewport = document.createElement('div');
    viewport.id = APP_MAIN_SCROLL_VIEWPORT_ID;
    Object.defineProperty(viewport, 'scrollTop', { value: 640, writable: true });
    document.body.appendChild(viewport);

    const unregister = registerAdvancedSearchSessionProvider(() => ({
      query: 'rock',
      genre: 'Jazz',
      yearFrom: '',
      yearTo: '',
      bpmFrom: '',
      bpmTo: '',
      moodGroup: '',
      losslessOnly: false,
      resultType: 'all',
      starredOnly: false,
      results: null,
      hasSearched: true,
      activeSearch: null,
      localMode: false,
      songsServerOffset: 0,
      songsHasMore: false,
      genreNote: false,
      basicSearchMode: false,
      tracksBrowseMode: false,
    }));

    saveAdvancedSearchLeaveSnapshot();
    expect(useAdvancedSearchSessionStore.getState().peekReturnStash()?.query).toBe('rock');
    expect(useAdvancedSearchSessionStore.getState().peekReturnStash()?.genre).toBe('Jazz');
    expect(useAdvancedSearchSessionStore.getState().peekReturnStash()?.scrollTop).toBe(640);
    unregister();
  });
});
