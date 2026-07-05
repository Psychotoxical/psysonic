import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { Track } from '@/lib/media/trackTypes';
import * as crossfadePreload from '@/features/playback/store/crossfadePreload';
import {
  armInterruptHandoff,
  clearInterruptHandoff,
  INTERRUPT_BLEND_PREP_FADE_SEC,
  isInterruptHandoffPending,
  runInterruptBlendPrep,
  shouldDeferInterruptHandoffUi,
} from '@/features/playback/utils/playback/autodjInterruptPrep';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

const track: Track = {
  id: 'b1',
  title: 'B',
  artist: 'A',
  album: '',
  albumId: '',
  duration: 200,
  suffix: 'mp3',
};

describe('runInterruptBlendPrep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    vi.spyOn(crossfadePreload, 'kickEagerCrossfadePreload').mockImplementation(() => {});
    vi.spyOn(crossfadePreload, 'isCrossfadeNextReady').mockReturnValue(false);
    vi.spyOn(crossfadePreload, 'waitForCrossfadeNextReady').mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fades the outgoing track and waits the prep window', async () => {
    armInterruptHandoff(7);
    const promise = runInterruptBlendPrep(track, 'srv', 'srv', () => false);
    await vi.advanceTimersByTimeAsync(INTERRUPT_BLEND_PREP_FADE_SEC * 1000);
    const result = await promise;
    expect(invoke).toHaveBeenCalledWith('audio_begin_outgoing_fade', {
      fadeSecs: INTERRUPT_BLEND_PREP_FADE_SEC,
    });
    expect(crossfadePreload.kickEagerCrossfadePreload).toHaveBeenCalledWith(track, 'srv', 'srv');
    expect(result).toEqual({ ready: false });
    clearInterruptHandoff();
  });

  it('tracks interrupt handoff pending state', () => {
    armInterruptHandoff(3);
    expect(isInterruptHandoffPending()).toBe(true);
    clearInterruptHandoff();
    expect(isInterruptHandoffPending()).toBe(false);
  });

  it('defers player UI only for cold interrupt handoffs', () => {
    expect(shouldDeferInterruptHandoffUi(true, false)).toBe(true);
    expect(shouldDeferInterruptHandoffUi(true, true)).toBe(false);
    expect(shouldDeferInterruptHandoffUi(false, false)).toBe(false);
  });
});
