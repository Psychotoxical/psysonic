import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useRadioMprisSync } from '@/features/radio/hooks/useRadioMprisSync';
import type { RadioMetadata } from '@/features/radio/hooks/useRadioMetadata';
import type { InternetRadioStation } from '@/lib/api/subsonicTypes';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
const invokeMock = vi.mocked(invoke);

// jsdom has no MediaSession / MediaMetadata — stub the standard W3C shapes.
class FakeMediaMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: unknown;
  constructor(init: Record<string, unknown>) { Object.assign(this, init); }
}
const ms = { metadata: null as FakeMediaMetadata | null, playbackState: 'none' };

beforeEach(() => {
  vi.clearAllMocks();
  ms.metadata = null;
  ms.playbackState = 'none';
  (globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = FakeMediaMetadata;
  Object.defineProperty(navigator, 'mediaSession', { value: ms, configurable: true });
});

const STATION = { id: 'r1', name: 'Test FM', streamUrl: 'https://radio.test/s' } as InternetRadioStation;
const NONE: RadioMetadata = { source: 'none', history: [] };
const meta = (over: Partial<RadioMetadata>): RadioMetadata => ({ source: 'icy', history: [], ...over });

describe('useRadioMprisSync', () => {
  it('feeds resolved radio metadata to navigator.mediaSession', async () => {
    renderHook(() =>
      useRadioMprisSync(meta({ currentTitle: 'Celebrity Skin', currentArtist: 'Hole' }), STATION));
    await waitFor(() => {
      expect(ms.metadata?.title).toBe('Celebrity Skin');
      expect(ms.metadata?.artist).toBe('Hole');
      expect(ms.playbackState).toBe('playing');
    });
  });

  it('mirrors the same metadata to the souvlaki controls', async () => {
    renderHook(() => useRadioMprisSync(meta({ currentTitle: 'Mind', currentArtist: 'TWO LANES' }), STATION));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('mpris_set_metadata',
        expect.objectContaining({ title: 'Mind', artist: 'TWO LANES' })));
  });

  it('falls back to the station name as artist when ICY has no artist', async () => {
    renderHook(() => useRadioMprisSync(meta({ currentTitle: 'Some Title' }), STATION));
    await waitFor(() => expect(ms.metadata?.artist).toBe('Test FM'));
  });

  it('does not push when the station sends no track metadata (no regression)', () => {
    renderHook(() => useRadioMprisSync(NONE, STATION));
    expect(ms.metadata).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not push when no radio station is active', () => {
    renderHook(() => useRadioMprisSync(meta({ currentTitle: 'X' }), null));
    expect(ms.metadata).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('dedupes unchanged re-emits but updates again when the track changes', async () => {
    const { rerender } = renderHook(({ m }) => useRadioMprisSync(m, STATION), {
      initialProps: { m: meta({ currentTitle: 'Track A', currentArtist: 'A' }) },
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    rerender({ m: meta({ currentTitle: 'Track A', currentArtist: 'A' }) });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    rerender({ m: meta({ currentTitle: 'Track B', currentArtist: 'B' }) });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(ms.metadata?.title).toBe('Track B');
    });
  });
});
