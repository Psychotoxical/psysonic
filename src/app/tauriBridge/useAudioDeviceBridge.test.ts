/**
 * useAudioDeviceBridge — characterisation tests for the payload-shape contract
 * introduced in PR #743.
 *
 * Payload shapes:
 *   null   → Rust replayed internally; frontend must NOT call playTrack.
 *   number → position captured by Rust; frontend calls playTrack + optionally
 *            sets seekFallbackVisualTarget (only when > 0.5 s).
 *
 * Both `audio:device-changed` and `audio:device-reset` share the same logic
 * (device-reset also clears the stored output device).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { emitTauriEvent } from '@/test/mocks/tauri';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack } from '@/test/helpers/factories';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { getSeekFallbackVisualTarget, setSeekFallbackVisualTarget } from '@/features/playback/store/seekFallbackState';
import { setIsAudioPaused } from '@/features/playback/store/engineState';
import { useAudioDeviceBridge } from '@/app/tauriBridge/useAudioDeviceBridge';

const track = makeTrack({ id: 't1', duration: 300 });

function mountBridge() {
  renderHook(() => useAudioDeviceBridge());
}

beforeEach(() => {
  resetAllStores();
  setSeekFallbackVisualTarget(null);
  // Module-level engine flag isn't covered by resetAllStores — reset explicitly.
  setIsAudioPaused(false);
  // Default: a track is playing.
  usePlayerStore.setState({ currentTrack: track, isPlaying: true });
});

// ─── audio:device-changed ───────────────────────────────────────────────────

describe('audio:device-changed', () => {
  it('skips playTrack when Rust handled replay (null payload)', () => {
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack } as never);
    mountBridge();

    emitTauriEvent('audio:device-changed', null);

    expect(playTrack).not.toHaveBeenCalled();
  });

  it('calls playTrack and sets seek target when position > 0.5', () => {
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack } as never);
    mountBridge();

    emitTauriEvent('audio:device-changed', 120.5);

    expect(playTrack).toHaveBeenCalledWith(track);
    expect(getSeekFallbackVisualTarget()).toMatchObject({
      trackId: track.id,
      seconds: 120.5,
    });
  });

  it('calls playTrack without seek target when position ≤ 0.5', () => {
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack } as never);
    mountBridge();

    emitTauriEvent('audio:device-changed', 0.0);

    expect(playTrack).toHaveBeenCalledWith(track);
    expect(getSeekFallbackVisualTarget()).toBeNull();
  });

  it('calls resetAudioPause instead of playTrack when paused', () => {
    const playTrack = vi.fn();
    const resetAudioPause = vi.fn();
    usePlayerStore.setState({ playTrack, resetAudioPause, isPlaying: false } as never);
    mountBridge();

    emitTauriEvent('audio:device-changed', 45.0);

    expect(playTrack).not.toHaveBeenCalled();
    expect(resetAudioPause).toHaveBeenCalled();
  });

  it('does nothing when there is no current track', () => {
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack, currentTrack: null } as never);
    mountBridge();

    emitTauriEvent('audio:device-changed', 30.0);

    expect(playTrack).not.toHaveBeenCalled();
  });

  it('does not restart when the engine is paused even if isPlaying is stale-true (#1094)', () => {
    const playTrack = vi.fn();
    const resetAudioPause = vi.fn();
    usePlayerStore.setState({ playTrack, resetAudioPause, isPlaying: true } as never);
    setIsAudioPaused(true);
    mountBridge();

    emitTauriEvent('audio:device-changed', 45.0);

    expect(playTrack).not.toHaveBeenCalled();
    expect(resetAudioPause).toHaveBeenCalled();
  });
});

// ─── audio:device-reset ─────────────────────────────────────────────────────

describe('audio:output-released', () => {
  it('calls resetAudioPause so the next resume uses the cold path', () => {
    const resetAudioPause = vi.fn();
    usePlayerStore.setState({ resetAudioPause } as never);
    mountBridge();

    emitTauriEvent('audio:output-released', null);

    expect(resetAudioPause).toHaveBeenCalled();
  });
});

// ─── audio:device-reset ─────────────────────────────────────────────────────

describe('audio:device-reset', () => {
  it('always clears the stored output device', () => {
    useAuthStore.setState({ audioOutputDevice: 'My DAC' } as never);
    mountBridge();

    emitTauriEvent('audio:device-reset', null);

    expect(useAuthStore.getState().audioOutputDevice).toBeNull();
  });

  it('skips playTrack when Rust handled replay (null payload)', () => {
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack } as never);
    mountBridge();

    emitTauriEvent('audio:device-reset', null);

    expect(playTrack).not.toHaveBeenCalled();
  });

  it('calls playTrack and sets seek target when position > 0.5', () => {
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack } as never);
    mountBridge();

    emitTauriEvent('audio:device-reset', 90.0);

    expect(playTrack).toHaveBeenCalledWith(track);
    expect(getSeekFallbackVisualTarget()).toMatchObject({
      trackId: track.id,
      seconds: 90.0,
    });
  });
});
