/**
 * Loudness-gain cache encapsulates two parallel maps and a small API that
 * playerStore drives from the audio-event handlers + cache refresh path.
 * The interesting behaviours: (a) stable-flag gating in
 * `loudnessGainDbForEngineBind` (partial values are silently invisible to
 * engine bind), (b) `clearLoudnessCacheStateForTrackId` expands across the
 * `stream:` prefix while `forgetLoudnessGain` does NOT (preserves the
 * existing direct-delete semantics from playerStore).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState } = vi.hoisted(() => ({
  authState: {
    normalizationEngine: 'off' as 'off' | 'replaygain' | 'loudness',
    replayGainEnabled: false,
  },
}));

vi.mock('./authStore', () => ({
  useAuthStore: { getState: () => authState },
}));

import {
  _resetLoudnessGainCacheForTest,
  clearLoudnessCacheStateForTrackId,
  forgetLoudnessGain,
  getCachedLoudnessGain,
  hasStableLoudness,
  isReplayGainActive,
  loudnessCacheStateKeysForTrackId,
  loudnessGainDbForEngineBind,
  markLoudnessStable,
  setCachedLoudnessGain,
} from './loudnessGainCache';

beforeEach(() => {
  authState.normalizationEngine = 'off';
  authState.replayGainEnabled = false;
});

afterEach(() => {
  _resetLoudnessGainCacheForTest();
});

describe('loudnessCacheStateKeysForTrackId', () => {
  it('returns bare + stream-prefixed form for a bare id', () => {
    expect(loudnessCacheStateKeysForTrackId('abc')).toEqual(['abc', 'stream:abc']);
  });

  it('returns stream-prefixed + bare form for a stream id', () => {
    expect(loudnessCacheStateKeysForTrackId('stream:abc')).toEqual(['stream:abc', 'abc']);
  });

  it('returns empty for an empty id', () => {
    expect(loudnessCacheStateKeysForTrackId('')).toEqual([]);
  });

  it('returns only the stream-prefixed form when the bare portion is empty', () => {
    expect(loudnessCacheStateKeysForTrackId('stream:')).toEqual(['stream:']);
  });
});

describe('getCachedLoudnessGain / setCachedLoudnessGain', () => {
  it('round-trips a value through the cache', () => {
    setCachedLoudnessGain('t1', -7.2);
    expect(getCachedLoudnessGain('t1')).toBe(-7.2);
  });

  it('returns undefined for missing entries', () => {
    expect(getCachedLoudnessGain('missing')).toBeUndefined();
  });
});

describe('hasStableLoudness / markLoudnessStable', () => {
  it('flags as stable only after markLoudnessStable', () => {
    setCachedLoudnessGain('t1', -7);
    expect(hasStableLoudness('t1')).toBe(false);
    markLoudnessStable('t1', -7);
    expect(hasStableLoudness('t1')).toBe(true);
  });

  it('markLoudnessStable writes the cached value atomically', () => {
    markLoudnessStable('t1', -5);
    expect(getCachedLoudnessGain('t1')).toBe(-5);
    expect(hasStableLoudness('t1')).toBe(true);
  });
});

describe('forgetLoudnessGain (single-key delete)', () => {
  it('clears both maps for the literal id only — does not touch the other form', () => {
    markLoudnessStable('t1', -5);
    markLoudnessStable('stream:t1', -6);
    forgetLoudnessGain('t1');
    expect(getCachedLoudnessGain('t1')).toBeUndefined();
    expect(hasStableLoudness('t1')).toBe(false);
    // Stream form must still be there — forget is intentionally narrow.
    expect(getCachedLoudnessGain('stream:t1')).toBe(-6);
    expect(hasStableLoudness('stream:t1')).toBe(true);
  });
});

describe('clearLoudnessCacheStateForTrackId (two-form delete)', () => {
  it('clears both maps for both id forms', () => {
    markLoudnessStable('t1', -5);
    markLoudnessStable('stream:t1', -6);
    clearLoudnessCacheStateForTrackId('t1');
    expect(getCachedLoudnessGain('t1')).toBeUndefined();
    expect(getCachedLoudnessGain('stream:t1')).toBeUndefined();
    expect(hasStableLoudness('t1')).toBe(false);
    expect(hasStableLoudness('stream:t1')).toBe(false);
  });

  it('also works when invoked with the stream-prefixed form', () => {
    markLoudnessStable('t1', -5);
    markLoudnessStable('stream:t1', -6);
    clearLoudnessCacheStateForTrackId('stream:t1');
    expect(getCachedLoudnessGain('t1')).toBeUndefined();
    expect(getCachedLoudnessGain('stream:t1')).toBeUndefined();
  });
});

describe('loudnessGainDbForEngineBind', () => {
  it('returns null without a stable flag (partial/placeholder values are hidden from engine bind)', () => {
    setCachedLoudnessGain('t1', -5);
    expect(loudnessGainDbForEngineBind('t1')).toBeNull();
  });

  it('returns the cached value once the entry is stable', () => {
    markLoudnessStable('t1', -5);
    expect(loudnessGainDbForEngineBind('t1')).toBe(-5);
  });

  it('returns null when the cached value is non-finite', () => {
    markLoudnessStable('t1', Number.NaN);
    expect(loudnessGainDbForEngineBind('t1')).toBeNull();
  });

  it('returns null for null / empty trackId input', () => {
    expect(loudnessGainDbForEngineBind(null)).toBeNull();
    expect(loudnessGainDbForEngineBind(undefined)).toBeNull();
    expect(loudnessGainDbForEngineBind('')).toBeNull();
  });
});

describe('isReplayGainActive', () => {
  it('is false when normalization engine is off', () => {
    authState.normalizationEngine = 'off';
    authState.replayGainEnabled = true;
    expect(isReplayGainActive()).toBe(false);
  });

  it('is false when engine is replaygain but flag is disabled', () => {
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = false;
    expect(isReplayGainActive()).toBe(false);
  });

  it('is true only when engine is replaygain AND the flag is enabled', () => {
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = true;
    expect(isReplayGainActive()).toBe(true);
  });

  it('is false when engine is loudness (different normalization mode)', () => {
    authState.normalizationEngine = 'loudness';
    authState.replayGainEnabled = true;
    expect(isReplayGainActive()).toBe(false);
  });
});

describe('_resetLoudnessGainCacheForTest', () => {
  it('wipes both maps', () => {
    markLoudnessStable('t1', -5);
    markLoudnessStable('t2', -6);
    _resetLoudnessGainCacheForTest();
    expect(getCachedLoudnessGain('t1')).toBeUndefined();
    expect(getCachedLoudnessGain('t2')).toBeUndefined();
    expect(hasStableLoudness('t1')).toBe(false);
  });
});
