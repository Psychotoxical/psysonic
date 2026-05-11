/**
 * Pure-helper characterization for `shuffleArray` (Fisher-Yates).
 *
 * Originally lived in `playerStore.ts`; extracted in M0 of the frontend
 * refactor (2026-05-12).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shuffleArray } from './shuffleArray';

describe('shuffleArray', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    shuffleArray(input);
    expect(input).toEqual(snapshot);
  });

  it('preserves the multiset of elements (same length, same members)', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffleArray(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('returns a copy (not the same reference)', () => {
    const input = [1, 2, 3];
    expect(shuffleArray(input)).not.toBe(input);
  });

  it('returns an empty array when called with an empty array', () => {
    expect(shuffleArray([])).toEqual([]);
  });

  it('returns the single-element input unchanged', () => {
    expect(shuffleArray(['only'])).toEqual(['only']);
  });

  it('produces a deterministic order under a mocked RNG (Math.random=0 picks j=0 each iteration)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // With Math.random()=0, j=floor(0 * (i+1))=0 for every i. The Fisher-Yates
    // step swaps arr[i] with arr[0]. Walk it through for [1,2,3,4]:
    //   i=3: swap(3,0) → [4,2,3,1]
    //   i=2: swap(2,0) → [3,2,4,1]
    //   i=1: swap(1,0) → [2,3,4,1]
    expect(shuffleArray([1, 2, 3, 4])).toEqual([2, 3, 4, 1]);
  });
});
