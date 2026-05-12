import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetRadioSessionStateForTest,
  addRadioSessionSeen,
  clearRadioSessionSeenIds,
  deleteRadioSessionSeen,
  getCurrentRadioArtistId,
  hasRadioSessionSeen,
  isRadioFetching,
  setCurrentRadioArtistId,
  setRadioFetching,
} from './radioSessionState';

afterEach(() => {
  _resetRadioSessionStateForTest();
});

describe('radioFetching', () => {
  it('starts false + round-trips through set/get', () => {
    expect(isRadioFetching()).toBe(false);
    setRadioFetching(true);
    expect(isRadioFetching()).toBe(true);
    setRadioFetching(false);
    expect(isRadioFetching()).toBe(false);
  });
});

describe('currentRadioArtistId', () => {
  it('starts null + round-trips', () => {
    expect(getCurrentRadioArtistId()).toBeNull();
    setCurrentRadioArtistId('artist-1');
    expect(getCurrentRadioArtistId()).toBe('artist-1');
    setCurrentRadioArtistId(null);
    expect(getCurrentRadioArtistId()).toBeNull();
  });
});

describe('radioSessionSeenIds', () => {
  it('starts empty', () => {
    expect(hasRadioSessionSeen('any')).toBe(false);
  });

  it('add + has round-trip', () => {
    addRadioSessionSeen('t1');
    expect(hasRadioSessionSeen('t1')).toBe(true);
    expect(hasRadioSessionSeen('t2')).toBe(false);
  });

  it('delete removes individual ids without affecting others', () => {
    addRadioSessionSeen('t1');
    addRadioSessionSeen('t2');
    deleteRadioSessionSeen('t1');
    expect(hasRadioSessionSeen('t1')).toBe(false);
    expect(hasRadioSessionSeen('t2')).toBe(true);
  });

  it('clearRadioSessionSeenIds wipes the set', () => {
    addRadioSessionSeen('t1');
    addRadioSessionSeen('t2');
    clearRadioSessionSeenIds();
    expect(hasRadioSessionSeen('t1')).toBe(false);
    expect(hasRadioSessionSeen('t2')).toBe(false);
  });
});

describe('_resetRadioSessionStateForTest', () => {
  it('resets all three pieces of state', () => {
    setRadioFetching(true);
    setCurrentRadioArtistId('artist-1');
    addRadioSessionSeen('t1');
    _resetRadioSessionStateForTest();
    expect(isRadioFetching()).toBe(false);
    expect(getCurrentRadioArtistId()).toBeNull();
    expect(hasRadioSessionSeen('t1')).toBe(false);
  });
});
