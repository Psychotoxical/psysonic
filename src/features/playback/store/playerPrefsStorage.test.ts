import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  persistPlayerPrefs,
  readInitialPlayerPrefs,
} from '@/features/playback/store/playerPrefsStorage';

const PREFS_KEY = 'psysonic_player_prefs';
const LEGACY_KEY = 'psysonic-player';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('readInitialPlayerPrefs', () => {
  it('defaults when nothing is stored', () => {
    expect(readInitialPlayerPrefs()).toEqual({ volume: 0.8, repeatMode: 'off' });
  });

  it('reads the dedicated prefs key', () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: 0.42, repeatMode: 'all' }));
    expect(readInitialPlayerPrefs()).toEqual({ volume: 0.42, repeatMode: 'all' });
  });

  it('clamps an out-of-range volume', () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: 1.5, repeatMode: 'one' }));
    expect(readInitialPlayerPrefs()).toEqual({ volume: 1, repeatMode: 'one' });
  });

  it('falls back to the legacy psysonic-player blob when the dedicated key is absent', () => {
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ state: { volume: 0.25, repeatMode: 'one', queueItems: [] } }),
    );
    expect(readInitialPlayerPrefs()).toEqual({ volume: 0.25, repeatMode: 'one' });
  });

  it('prefers the dedicated key over the legacy blob', () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: 0.6, repeatMode: 'off' }));
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ state: { volume: 0.1, repeatMode: 'all' } }),
    );
    expect(readInitialPlayerPrefs()).toEqual({ volume: 0.6, repeatMode: 'off' });
  });
});

describe('persistPlayerPrefs', () => {
  it('round-trips through readInitialPlayerPrefs', () => {
    persistPlayerPrefs({ volume: 0.33, repeatMode: 'all' });
    expect(readInitialPlayerPrefs()).toEqual({ volume: 0.33, repeatMode: 'all' });
  });
});
