import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetInfiniteQueueStateForTest,
  isInfiniteQueueFetching,
  setInfiniteQueueFetching,
} from './infiniteQueueState';

afterEach(() => {
  _resetInfiniteQueueStateForTest();
});

describe('infiniteQueueFetching', () => {
  it('starts false', () => {
    expect(isInfiniteQueueFetching()).toBe(false);
  });

  it('round-trips through set/get', () => {
    setInfiniteQueueFetching(true);
    expect(isInfiniteQueueFetching()).toBe(true);
    setInfiniteQueueFetching(false);
    expect(isInfiniteQueueFetching()).toBe(false);
  });

  it('_resetInfiniteQueueStateForTest resets to false', () => {
    setInfiniteQueueFetching(true);
    _resetInfiniteQueueStateForTest();
    expect(isInfiniteQueueFetching()).toBe(false);
  });
});
