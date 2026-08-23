import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { offlineActionPolicy } from '@/features/offline';
import PlaylistHero from '@/features/playlist/components/PlaylistHero';
import { usePlaylistLayoutStore } from '@/features/playlist/store/playlistLayoutStore';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

function playlist(over: Partial<SubsonicPlaylist> = {}): SubsonicPlaylist {
  return {
    id: 'pl-1',
    name: 'Feishin mix',
    smart: true,
    songCount: 1,
    duration: 120,
    created: '',
    changed: '',
    serverId: 'srv-a',
    ...over,
  };
}

function renderHero(pl: SubsonicPlaylist, handleRefreshSmart = vi.fn()) {
  return renderWithProviders(
    <PlaylistHero
      playlist={pl}
      songs={[]}
      id={pl.id}
      customCoverId={null}
      coverQuadIds={[null, null, null, null]}
      resolvedBgUrl={null}
      saving={false}
      refreshingSmart={false}
      searchOpen={false}
      csvImporting={false}
      activeZip={undefined}
      offlineStatus="none"
      offlineProgress={null}
      activeServerId="srv-a"
      actionPolicy={offlineActionPolicy('playlistDetail', false)}
      setEditingMeta={vi.fn()}
      setSearchOpen={vi.fn()}
      setSearchQuery={vi.fn()}
      setSearchResults={vi.fn()}
      setSelectedSearchIds={vi.fn()}
      setSearchPlPickerOpen={vi.fn()}
      handlePlayAll={vi.fn()}
      handleShuffleAll={vi.fn()}
      handleEnqueueAll={vi.fn()}
      handleImportCsv={vi.fn()}
      handleDownload={vi.fn()}
      handleRefreshSmart={handleRefreshSmart}
      deleteAlbum={vi.fn()}
      downloadPlaylist={vi.fn()}
    />,
  );
}

describe('PlaylistHero smart surfaces', () => {
  beforeEach(() => {
    usePlaylistLayoutStore.getState().reset();
  });

  it('hides add/import and exposes Edit Rules for smart playlists', async () => {
    const user = userEvent.setup();
    const handleRefreshSmart = vi.fn();
    navigateMock.mockReset();
    const view = renderHero(playlist(), handleRefreshSmart);

    expect(view.queryByRole('button', { name: 'Search your library to add tracks' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Import from Spotify CSV' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Cache playlist offline' })).not.toBeInTheDocument();

    expect(view.getByRole('button', { name: 'Edit Rules' })).toHaveTextContent('Edit Rules');
    await user.click(view.getByRole('button', { name: 'Edit Rules' }));
    expect(navigateMock).toHaveBeenCalledWith('/playlists', {
      state: { openSmartEditorFor: { id: 'pl-1', serverId: 'srv-a', name: 'Feishin mix' } },
    });
    await user.click(view.getByRole('button', { name: 'Refresh smart playlist' }));
    expect(handleRefreshSmart).toHaveBeenCalledOnce();
  });

  it('keeps add/import on regular playlists and omits Edit Rules', () => {
    const view = renderHero(playlist({ name: 'Manual mix', smart: false }));
    expect(view.getByRole('button', { name: 'Search your library to add tracks' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Import from Spotify CSV' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Edit Rules' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Refresh smart playlist' })).not.toBeInTheDocument();
  });

  it('respects playlist layout visibility for smart actions', () => {
    usePlaylistLayoutStore.getState().toggleItem('editRules');
    usePlaylistLayoutStore.getState().toggleItem('refreshSmart');
    const view = renderHero(playlist());

    expect(view.queryByRole('button', { name: 'Edit Rules' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Refresh smart playlist' })).not.toBeInTheDocument();
  });
});
