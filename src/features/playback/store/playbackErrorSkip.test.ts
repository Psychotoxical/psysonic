import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerationGuardedPlaybackSkip } from './playbackErrorSkip';

describe('createGenerationGuardedPlaybackSkip', () => {
  afterEach(() => vi.useRealTimers());

  it('skips after the normal delay while the failed play generation is current', () => {
    vi.useFakeTimers();
    const skip = vi.fn();
    const resume = createGenerationGuardedPlaybackSkip({
      generation: 4,
      getGeneration: () => 4,
      skip,
    });

    resume();
    vi.advanceTimersByTime(1499);
    expect(skip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('does not skip after a newer playback generation supersedes the failure', () => {
    vi.useFakeTimers();
    let generation = 4;
    const skip = vi.fn();
    const resume = createGenerationGuardedPlaybackSkip({
      generation,
      getGeneration: () => generation,
      skip,
    });

    resume();
    generation = 5;
    vi.runAllTimers();
    expect(skip).not.toHaveBeenCalled();
  });
});
