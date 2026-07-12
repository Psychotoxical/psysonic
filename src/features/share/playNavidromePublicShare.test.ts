import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { playNavidromePublicShare } from '@/features/share/playNavidromePublicShare';
import type { NavidromePublicShareInfo } from '@/lib/share/navidromePublicShareTypes';
import { resetPlayerStore } from '@/test/helpers/storeReset';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';

vi.mock('@/lib/dom/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/features/playback/store/queueTrackResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/playback/store/queueTrackResolver')>();
  return {
    ...actual,
    seedQueueResolver: vi.fn(),
  };
});

const shareRef = {
  pageUrl: 'https://music.test/share/AbCdEfGhIj',
  origin: 'https://music.test',
  basePath: '',
  shareId: 'AbCdEfGhIj',
};

const shareInfo: NavidromePublicShareInfo = {
  id: 'AbCdEfGhIj',
  description: '',
  downloadable: false,
  tracks: [{
    id: 'jwt-token',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
  }],
};

describe('playNavidromePublicShare', () => {
  beforeEach(() => {
    resetPlayerStore();
    registerDefaultCoverInvokeHandlers();
    onInvoke('audio_play', () => undefined);
    onInvoke('audio_pause', () => undefined);
    onInvoke('audio_stop', () => undefined);
    onInvoke('audio_seek', () => undefined);
    onInvoke('audio_get_state', () => ({ playing: false }));
    onInvoke('audio_update_replay_gain', () => undefined);
    onInvoke('discord_update_presence', () => undefined);
    onInvoke('library_get_recent_play_sessions', () => []);
  });

  it('stores the Navidrome share page URL for queue toolbar copy', async () => {
    const t = ((key: string) => key) as never;
    const ok = await playNavidromePublicShare(shareRef, shareInfo, t);
    expect(ok).toBe(true);
    expect(usePlayerStore.getState().navidromePublicSharePageUrl).toBe(shareRef.pageUrl);
  });
});
