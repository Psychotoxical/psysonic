import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTracks, seedQueue } from '@/test/helpers/factories';
import { getTimelineSessionHistorySnapshot } from '@/features/playback/store/timelineSessionHistory';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';

describe('timeline history on queue replace', () => {
  beforeEach(() => {
    resetAllStores();
    const id = useAuthStore.getState().addServer({
      name: 'T', url: 'https://x.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(id);
    registerDefaultCoverInvokeHandlers();
    onInvoke('audio_play', () => undefined);
    onInvoke('audio_stop', () => undefined);
    onInvoke('audio_seek', () => undefined);
    onInvoke('audio_get_state', () => ({ playing: false }));
    onInvoke('audio_update_replay_gain', () => undefined);
    onInvoke('discord_update_presence', () => undefined);
  });

  it('keeps session history when playTrack replaces the queue', async () => {
    const first = makeTracks(1);
    seedQueue(first, { index: 0, currentTrack: first[0] });
    const album = makeTracks(3);
    usePlayerStore.getState().playTrack(album[0]!, album, true, true);
    await vi.waitFor(() => {
      expect(usePlayerStore.getState().queueItems.map(r => r.trackId)).toEqual(album.map(t => t.id));
    });
    const history = getTimelineSessionHistorySnapshot();
    expect(history.some(h => h.trackId === first[0]!.id)).toBe(true);
  });
});
