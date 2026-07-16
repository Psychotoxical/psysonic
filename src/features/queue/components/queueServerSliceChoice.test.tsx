import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import QueuePanel from '@/features/queue/components/QueuePanel';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeServer, makeTrack } from '@/test/helpers/factories';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { decodeSharePayloadFromText } from '@/lib/share/shareLink';
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

function seedMixedQueue() {
  const first = makeServer({ id: 'a', name: 'Server A', url: 'https://a.test' });
  const second = makeServer({ id: 'b', name: 'Server B', url: 'https://b.test' });
  const firstKey = serverIndexKeyForProfile(first);
  const secondKey = serverIndexKeyForProfile(second);
  const a1 = makeTrack({ id: 'a-1', serverId: first.id });
  const b1 = makeTrack({ id: 'b-1', serverId: second.id });
  const b2 = makeTrack({ id: 'b-2', serverId: second.id });
  useAuthStore.setState({
    servers: [first, second],
    activeServerId: first.id,
    musicLibraryServerIds: [first.id, second.id],
  });
  seedQueueResolver(first.id, [a1]);
  seedQueueResolver(second.id, [b1, b2]);
  usePlayerStore.setState({
    queueItems: [
      { serverId: firstKey, trackId: a1.id },
      { serverId: secondKey, trackId: b1.id },
      { serverId: secondKey, trackId: b2.id },
    ],
    queueServerId: firstKey,
    queueIndex: 0,
    currentTrack: a1,
  });
}

describe('mixed-server queue export choice', () => {
  beforeEach(() => {
    resetAllStores();
    copyTextToClipboardMock.mockClear();
    seedMixedQueue();
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

  it('shares the explicitly chosen complete server slice with the v1 queue payload', async () => {
    const { getByLabelText, getByRole } = renderWithProviders(<QueuePanel />);
    fireEvent.click(getByLabelText('Copy queue share link'));

    const dialog = getByRole('dialog', { name: 'Choose a server slice to share' });
    expect(dialog).toHaveTextContent('Server A');
    expect(dialog).toHaveTextContent('1 track');
    expect(dialog).toHaveTextContent('Server B');
    expect(dialog).toHaveTextContent('2 tracks');

    fireEvent.click(getByRole('radio', { name: /Server B.*2 tracks/i }));
    fireEvent.click(getByRole('button', { name: 'Copy this slice' }));

    expect(copyTextToClipboardMock).toHaveBeenCalledTimes(1);
    const payload = decodeSharePayloadFromText(copyTextToClipboardMock.mock.calls[0][0]);
    expect(payload).toEqual({ srv: 'https://b.test', k: 'queue', ids: ['b-1', 'b-2'] });
  });

  it('cancels a mixed-server save without opening the playlist-name modal', () => {
    const { getByLabelText, getByRole, queryByRole, queryByPlaceholderText } = renderWithProviders(<QueuePanel />);
    fireEvent.click(getByLabelText('Playlist'));
    fireEvent.click(getByRole('button', { name: 'Save Playlist' }));
    expect(getByRole('dialog', { name: 'Choose a server slice to save' })).toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: 'Cancel' }));

    expect(queryByRole('dialog', { name: 'Choose a server slice to save' })).not.toBeInTheDocument();
    expect(queryByPlaceholderText('Playlist Name')).not.toBeInTheDocument();
  });
});
