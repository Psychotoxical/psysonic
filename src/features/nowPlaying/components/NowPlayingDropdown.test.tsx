import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAllStores } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import NowPlayingDropdown from './NowPlayingDropdown';
import { setServerReachability } from '@/lib/network/serverReachability';

const { getNowPlayingForServersMock, coverScopes, navigateMock } = vi.hoisted(() => ({
  getNowPlayingForServersMock: vi.fn(),
  coverScopes: [] as unknown[],
  navigateMock: vi.fn(),
}));

vi.mock('react-router-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/lib/api/subsonicScrobble', () => ({
  getNowPlayingForServers: getNowPlayingForServersMock,
}));

vi.mock('@/cover/CoverArtImage', () => ({
  CoverArtImage: () => <div data-testid="cover" />,
}));

vi.mock('@/cover/useLibraryCoverRef', async importOriginal => {
  const actual = await importOriginal<typeof import('@/cover/useLibraryCoverRef')>();
  return {
    ...actual,
    usePresenceCoverRef: (
      song: { albumId?: string | null } | null | undefined,
      serverScope: unknown,
    ) => {
      coverScopes.push(serverScope);
      return {
        cacheKind: 'album',
        cacheEntityId: song?.albumId ?? 'x',
        fetchCoverArtId: song?.albumId ?? 'x',
        serverScope,
      };
    },
  };
});

function entry(serverId: string, id: string, username: string) {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumId: `album-${id}`,
    coverArt: `cover-${id}`,
    duration: 180,
    username,
    minutesAgo: 0,
    playerId: 1,
    playerName: 'Web',
    serverId,
  };
}

beforeEach(() => {
  resetAllStores();
  coverScopes.length = 0;
  navigateMock.mockReset();
  getNowPlayingForServersMock.mockReset();
  useAuthStore.setState({
    servers: [
      { id: 'a', name: 'Alpha', url: 'http://a.test', username: 'owner-a', password: 'p' },
      { id: 'b', name: 'Beta', url: 'http://b.test', username: 'owner-b', password: 'p' },
    ],
    activeServerId: 'a',
    libraryBrowseServerIds: ['a', 'b'],
    isLoggedIn: true,
  });
  usePlayerStore.setState({ isPlaying: false, queueItems: [], queueServerId: null, queueIndex: 0 });
});

describe('NowPlayingDropdown multi-server scope', () => {
  it('renders listeners from every selected server with owner labels and cover scopes', async () => {
    getNowPlayingForServersMock.mockResolvedValue([
      entry('b', 'two', 'bob'),
      entry('a', 'one', 'alice'),
    ]);
    renderWithProviders(<NowPlayingDropdown />);

    fireEvent.click(screen.getByRole('button', { name: /Live/i }));
    expect(await screen.findByText('Track one')).toBeInTheDocument();
    expect(screen.getByText('Track two')).toBeInTheDocument();
    expect(screen.getByText('alice (Web)')).toBeInTheDocument();
    expect(screen.getByText('bob (Web)')).toBeInTheDocument();
    const headings = screen.getAllByText(/Alpha|Beta/).filter(node =>
      node.classList.contains('nav-library-server-group-heading'),
    );
    expect(headings.map(node => node.textContent)).toEqual(['Alpha', 'Beta']);
    expect(getNowPlayingForServersMock).toHaveBeenCalledWith(['a', 'b']);
    expect(coverScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'server', serverId: 'a' }),
      expect.objectContaining({ kind: 'server', serverId: 'b' }),
    ]));
  });

  it('isolates the live pulse when listeners are present', async () => {
    getNowPlayingForServersMock.mockResolvedValue([entry('b', 'two', 'bob')]);
    renderWithProviders(<NowPlayingDropdown />);

    const trigger = screen.getByRole('button', { name: /Live/i });
    await waitFor(() => expect(trigger).toHaveTextContent('1'));
    expect(trigger.querySelector('.now-playing-dropdown__live-icon')).toHaveClass(
      'now-playing-dropdown__live-icon--active',
    );
    expect(trigger.querySelector('.animate-pulse')).toBeNull();
  });

  it('keeps the owning server in album navigation', async () => {
    getNowPlayingForServersMock.mockResolvedValue([entry('b', 'two', 'bob')]);
    renderWithProviders(<NowPlayingDropdown />);

    fireEvent.click(screen.getByRole('button', { name: /Live/i }));
    fireEvent.click(await screen.findByText('Track two'));
    expect(navigateMock).toHaveBeenCalledWith('/album/album-two?server=b');
  });

  it('refetches when the selected server scope changes', async () => {
    getNowPlayingForServersMock.mockResolvedValue([]);
    renderWithProviders(<NowPlayingDropdown />);
    await waitFor(() => expect(getNowPlayingForServersMock).toHaveBeenCalledWith(['a', 'b']));

    useAuthStore.setState({ libraryBrowseServerIds: ['b'] });
    await waitFor(() => expect(getNowPlayingForServersMock).toHaveBeenCalledWith(['b']));
  });

  it('omits a confirmed unavailable server from polling', async () => {
    setServerReachability('b', 'unavailable');
    getNowPlayingForServersMock.mockResolvedValue([]);

    renderWithProviders(<NowPlayingDropdown />);

    await waitFor(() => expect(getNowPlayingForServersMock).toHaveBeenCalledWith(['a']));
    expect(useAuthStore.getState().libraryBrowseServerIds).toEqual(['a', 'b']);
  });

  it('does not render a server heading for a single-server scope', async () => {
    useAuthStore.setState({ libraryBrowseServerIds: ['b'] });
    getNowPlayingForServersMock.mockResolvedValue([entry('b', 'two', 'bob')]);
    renderWithProviders(<NowPlayingDropdown />);

    fireEvent.click(screen.getByRole('button', { name: /Live/i }));
    expect(await screen.findByText('Track two')).toBeInTheDocument();
    expect(document.querySelector('.nav-library-server-group-heading')).toBeNull();
  });

  it('drops stale own-account sessions from the previous playback server', async () => {
    getNowPlayingForServersMock.mockResolvedValue([
      entry('a', 'stale-local', 'owner-a'),
      entry('b', 'remote-client', 'owner-b'),
    ]);
    usePlayerStore.setState({
      isPlaying: true,
      queueItems: [
        { serverId: 'a', trackId: 'stale-local' },
        { serverId: 'b', trackId: 'remote-client' },
      ],
      queueServerId: 'a',
      queueIndex: 1,
    });
    renderWithProviders(<NowPlayingDropdown />);

    fireEvent.click(screen.getByRole('button', { name: /Live/i }));
    expect(await screen.findByText('Track remote-client')).toBeInTheDocument();
    expect(screen.queryByText('Track stale-local')).not.toBeInTheDocument();
  });

  it('drops stopped rows returned by a server', async () => {
    getNowPlayingForServersMock.mockResolvedValue([
      { ...entry('a', 'stopped', 'alice'), state: 'stopped' },
      entry('b', 'playing', 'bob'),
    ]);
    renderWithProviders(<NowPlayingDropdown />);

    fireEvent.click(screen.getByRole('button', { name: /Live/i }));
    expect(await screen.findByText('Track playing')).toBeInTheDocument();
    expect(screen.queryByText('Track stopped')).not.toBeInTheDocument();
  });
});
