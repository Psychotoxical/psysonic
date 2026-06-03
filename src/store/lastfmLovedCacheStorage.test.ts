import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  persistLastfmLovedCache,
  readInitialLastfmLovedCache,
} from './lastfmLovedCacheStorage';

const CACHE_KEY = 'psysonic_lastfm_loved_cache';
const LEGACY_KEY = 'psysonic-player';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('readInitialLastfmLovedCache', () => {
  it('defaults to an empty object when nothing is stored', () => {
    expect(readInitialLastfmLovedCache()).toEqual({});
  });

  it('reads the dedicated cache key and drops non-boolean entries', () => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ 'Hello::Adele': true, 'Bad::': false, '': true, n: 1 }),
    );
    expect(readInitialLastfmLovedCache()).toEqual({ 'Hello::Adele': true, 'Bad::': false });
  });

  it('falls back to the legacy psysonic-player blob', () => {
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        state: {
          lastfmLovedCache: { 'T::A': true },
          queueItems: [],
        },
      }),
    );
    expect(readInitialLastfmLovedCache()).toEqual({ 'T::A': true });
  });

  it('prefers the dedicated key over the legacy blob', () => {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ 'A::B': false }));
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ state: { lastfmLovedCache: { 'A::B': true } } }),
    );
    expect(readInitialLastfmLovedCache()).toEqual({ 'A::B': false });
  });
});

describe('persistLastfmLovedCache', () => {
  it('round-trips through readInitialLastfmLovedCache', () => {
    persistLastfmLovedCache({ 'Song::Artist': true });
    expect(readInitialLastfmLovedCache()).toEqual({ 'Song::Artist': true });
  });
});
