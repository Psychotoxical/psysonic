import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import QueuePanel from '@/features/queue/components/QueuePanel';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack } from '@/test/helpers/factories';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';

const copyTextToClipboardMock = vi.fn(async (_text: string) => true);

vi.mock('@/lib/server/serverMagicString', () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboardMock(text),
}));

vi.mock('@/features/orbit/utils/orbitBulkGuard', () => ({
  orbitBulkGuard: vi.fn(async () => true),
}));

vi.mock('@/lib/api/subsonic', () => ({
  savePlayQueue: vi.fn(async () => undefined),
  getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
  buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
  buildCoverArtUrl: vi.fn((id: string) => `https://mock/cover/${id}`),
  getSong: vi.fn(async () => null),
}));

function seedPublicShareQueue(pageUrl: string) {
  const track = {
    ...makeTrack({ id: 'ndshare:AbCdEfGhIj:0', serverId: 'navidrome-public-share' }),
    directStreamUrl: 'https://music.test/share/s/jwt-token',
  };
  usePlayerStore.setState({
    queueServerId: 'navidrome-public-share',
    navidromePublicSharePageUrl: pageUrl,
    queueItems: [{
      serverId: 'navidrome-public-share',
      trackId: 'ndshare:AbCdEfGhIj:0',
      directStreamUrl: track.directStreamUrl,
    }],
    queueIndex: 0,
    currentTrack: track,
  });
}

describe('QueuePanel public share toolbar', () => {
  beforeEach(() => {
    resetAllStores();
    copyTextToClipboardMock.mockClear();
    const id = useAuthStore.getState().addServer({
      name: 'T', url: 'https://x.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(id);
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

  it('hides Save Playlist in the playlist menu for a Navidrome public share queue', () => {
    seedPublicShareQueue('https://music.test/share/AbCdEfGhIj');
    const { getByLabelText, container } = renderWithProviders(<QueuePanel />);
    fireEvent.click(getByLabelText('Playlist'));
    const menu = container.querySelector('.queue-menu');
    expect(menu?.textContent).not.toContain('Save Playlist');
    expect(menu?.textContent).toContain('Load Playlist');
  });

  it('copies the original Navidrome share page URL from the share button', async () => {
    const pageUrl = 'https://music.test/share/AbCdEfGhIj';
    seedPublicShareQueue(pageUrl);
    const { getByLabelText } = renderWithProviders(<QueuePanel />);
    fireEvent.click(getByLabelText('Copy Navidrome share link'));
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(pageUrl);
  });
});
