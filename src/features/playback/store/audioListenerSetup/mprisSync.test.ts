import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  mprisSetMetadata: vi.fn(() => Promise.resolve()),
  mprisSetPlayback: vi.fn(() => Promise.resolve()),
  mprisSetVolume: vi.fn(() => Promise.resolve()),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/api/mpris', () => ({
  mprisSetMetadata: hoisted.mprisSetMetadata,
  mprisSetPlayback: hoisted.mprisSetPlayback,
  mprisSetVolume: hoisted.mprisSetVolume,
}));
vi.mock('@/cover/resolveEntryLibrary', () => ({
  resolveTrackCoverRefFromLibrary: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/cover/integrations/mpris', () => ({
  coverArtUrlForMpris: vi.fn(() => Promise.resolve('')),
}));
vi.mock('@/features/playback/store/playbackProgress', () => ({
  getPlaybackProgressSnapshot: () => ({ currentTime: 0 }),
  subscribePlaybackProgress: () => () => {},
}));

import { setupMprisSync } from './mprisSync';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetPlayerStore } from '@/test/helpers/storeReset';

describe('setupMprisSync radio ownership', () => {
  beforeEach(() => {
    resetPlayerStore();
    hoisted.mprisSetMetadata.mockClear();
    hoisted.mprisSetPlayback.mockClear();
    hoisted.mprisSetVolume.mockClear();
  });

  it('pushes metadata when radio ownership changes but the raw id is the same', () => {
    const cleanup = setupMprisSync();
    usePlayerStore.setState({
      currentRadio: {
        id: 'shared',
        serverId: 'srv-a',
        name: 'Alpha Radio',
        streamUrl: 'https://a.test/live',
      },
      isPlaying: true,
    });
    usePlayerStore.setState({
      currentRadio: {
        id: 'shared',
        serverId: 'srv-b',
        name: 'Beta Radio',
        streamUrl: 'https://b.test/live',
      },
      isPlaying: true,
    });

    expect(hoisted.mprisSetMetadata).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: 'Alpha Radio',
    }));
    expect(hoisted.mprisSetMetadata).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: 'Beta Radio',
    }));
    cleanup();
  });

  it('pushes the initial volume and subsequent changes', () => {
    usePlayerStore.setState({ volume: 0.35 });
    const cleanup = setupMprisSync();

    expect(hoisted.mprisSetVolume).toHaveBeenNthCalledWith(1, 0.35);

    usePlayerStore.setState({ volume: 0.7 });

    expect(hoisted.mprisSetVolume).toHaveBeenNthCalledWith(2, 0.7);
    cleanup();
  });
});
