import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  persistQueueVisibility,
  readInitialQueueVisibility,
} from './queueVisibilityStorage';

const KEY = 'psysonic_queue_visible';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('readInitialQueueVisibility', () => {
  it('defaults to true when no value is stored', () => {
    expect(readInitialQueueVisibility()).toBe(true);
  });

  it('returns true for the "true" string', () => {
    window.localStorage.setItem(KEY, 'true');
    expect(readInitialQueueVisibility()).toBe(true);
  });

  it('returns false for the "false" string', () => {
    window.localStorage.setItem(KEY, 'false');
    expect(readInitialQueueVisibility()).toBe(false);
  });

  it('falls back to true on an unexpected stored value', () => {
    window.localStorage.setItem(KEY, 'maybe');
    expect(readInitialQueueVisibility()).toBe(true);
  });
});

describe('persistQueueVisibility', () => {
  it('stores "true" / "false" as strings', () => {
    persistQueueVisibility(true);
    expect(window.localStorage.getItem(KEY)).toBe('true');
    persistQueueVisibility(false);
    expect(window.localStorage.getItem(KEY)).toBe('false');
  });

  it('round-trips through readInitialQueueVisibility', () => {
    persistQueueVisibility(false);
    expect(readInitialQueueVisibility()).toBe(false);
    persistQueueVisibility(true);
    expect(readInitialQueueVisibility()).toBe(true);
  });
});
