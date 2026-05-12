import { afterEach, describe, expect, it } from 'vitest';
import {
  LIVE_PROGRESS_EMIT_MIN_DELTA_SEC,
  LIVE_PROGRESS_EMIT_MIN_MS,
  NORMALIZATION_UI_THROTTLE_MS,
  STORE_PROGRESS_COMMIT_MIN_DELTA_SEC,
  STORE_PROGRESS_COMMIT_MIN_MS,
  _resetPlaybackThrottlesForTest,
  getLastLiveProgressEmitAt,
  getLastNormalizationUiUpdateAtMs,
  getLastStoreProgressCommitAt,
  markLiveProgressEmit,
  markNormalizationUiUpdate,
  markStoreProgressCommit,
  resetProgressEmitThrottles,
} from './playbackThrottles';

afterEach(() => {
  _resetPlaybackThrottlesForTest();
});

describe('constants', () => {
  it('match the values the runtime expects', () => {
    expect(LIVE_PROGRESS_EMIT_MIN_MS).toBe(1500);
    expect(LIVE_PROGRESS_EMIT_MIN_DELTA_SEC).toBe(0.9);
    expect(STORE_PROGRESS_COMMIT_MIN_MS).toBe(20_000);
    expect(STORE_PROGRESS_COMMIT_MIN_DELTA_SEC).toBe(5.0);
    expect(NORMALIZATION_UI_THROTTLE_MS).toBe(120);
  });
});

describe('throttle accessors', () => {
  it('all start at 0', () => {
    expect(getLastLiveProgressEmitAt()).toBe(0);
    expect(getLastStoreProgressCommitAt()).toBe(0);
    expect(getLastNormalizationUiUpdateAtMs()).toBe(0);
  });

  it('mark + get round-trip independently for each throttle', () => {
    markLiveProgressEmit(1000);
    markStoreProgressCommit(2000);
    markNormalizationUiUpdate(3000);
    expect(getLastLiveProgressEmitAt()).toBe(1000);
    expect(getLastStoreProgressCommitAt()).toBe(2000);
    expect(getLastNormalizationUiUpdateAtMs()).toBe(3000);
  });

  it('mark overwrites a previous value', () => {
    markLiveProgressEmit(1000);
    markLiveProgressEmit(2000);
    expect(getLastLiveProgressEmitAt()).toBe(2000);
  });
});

describe('resetProgressEmitThrottles', () => {
  it('zeros both progress throttles but leaves normalization UI alone', () => {
    markLiveProgressEmit(1000);
    markStoreProgressCommit(2000);
    markNormalizationUiUpdate(3000);
    resetProgressEmitThrottles();
    expect(getLastLiveProgressEmitAt()).toBe(0);
    expect(getLastStoreProgressCommitAt()).toBe(0);
    expect(getLastNormalizationUiUpdateAtMs()).toBe(3000);
  });
});

describe('_resetPlaybackThrottlesForTest', () => {
  it('zeros all three timestamps', () => {
    markLiveProgressEmit(1);
    markStoreProgressCommit(2);
    markNormalizationUiUpdate(3);
    _resetPlaybackThrottlesForTest();
    expect(getLastLiveProgressEmitAt()).toBe(0);
    expect(getLastStoreProgressCommitAt()).toBe(0);
    expect(getLastNormalizationUiUpdateAtMs()).toBe(0);
  });
});
