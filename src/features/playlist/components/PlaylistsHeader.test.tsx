import { useRef, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlaylistsHeader from '@/features/playlist/components/PlaylistsHeader';
import { usePlaylistLayoutStore } from '@/features/playlist/store/playlistLayoutStore';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

function HeaderHarness({
  createServerOptions = [
    { id: 'server-a', label: 'Server A' },
    { id: 'server-b', label: 'Server B' },
  ],
  ownershipCounts = { personal: 0, sharedByMe: 0, sharedWithMe: 0 },
}: {
  createServerOptions?: Array<{ id: string; label: string }>;
  ownershipCounts?: { personal: number; sharedByMe: number; sharedWithMe: number };
}) {
  const [creating, setCreating] = useState(false);
  const [creatingSmart, setCreatingSmart] = useState(false);
  const [newName, setNewName] = useState('');
  const [serverId, setServerId] = useState('server-a');
  const nameInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <PlaylistsHeader
        selectionMode={false}
        selectedIds={new Set()}
        selectedPlaylists={[]}
        isPlaylistDeletable={() => true}
        toggleSelectionMode={vi.fn()}
        handleDeleteSelected={vi.fn()}
        creating={creating}
        setCreating={setCreating}
        setCreatingSmart={setCreatingSmart}
        newName={newName}
        setNewName={setNewName}
        nameInputRef={nameInputRef}
        handleCreate={vi.fn(async () => {})}
        createServerId={serverId}
        setCreateServerId={setServerId}
        createServerOptions={createServerOptions}
        smartCreateServerOptions={[{ id: 'server-b', label: 'Server B' }]}
        setEditingSmartId={vi.fn()}
        setSmartFilters={vi.fn()}
        setGenreQuery={vi.fn()}
        onEditorIntent={vi.fn()}
        foldersEnabled={false}
        ownershipCounts={ownershipCounts}
      />
      {creatingSmart && <div data-testid="smart-editor-open" />}
      <div data-testid="selected-server">{serverId}</div>
    </>
  );
}

describe('PlaylistsHeader', () => {
  // The ownership filter lives in a persisted store, so a test that clicks a
  // bucket would otherwise decide what the next test sees.
  beforeEach(() => {
    usePlaylistLayoutStore.getState().setOwnershipFilter('all');
  });

  it('reveals playlist name and server only after New Playlist is pressed', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<HeaderHarness />);

    expect(view.queryByRole('textbox', { name: 'Playlist Name' })).not.toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();

    await user.click(view.getByRole('button', { name: 'New Playlist' }));

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    const serverSelect = view.getByRole('combobox', { name: 'Servers' });
    expect(serverSelect).toHaveTextContent('Server A');

    await user.click(serverSelect);
    await user.click(view.getByRole('option', { name: 'Server B' }));
    expect(serverSelect).toHaveTextContent('Server B');

    await user.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('textbox', { name: 'Playlist Name' })).not.toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });

  it('selects a Navidrome owner when opening the smart playlist editor', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<HeaderHarness />);

    expect(view.getByTestId('selected-server')).toHaveTextContent('server-a');
    await user.click(view.getByRole('button', { name: 'New Smart Playlist' }));

    expect(view.getByTestId('smart-editor-open')).toBeInTheDocument();
    expect(view.getByTestId('selected-server')).toHaveTextContent('server-b');
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });

  it('hides the server selector when creating in single-server mode', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <HeaderHarness createServerOptions={[{ id: 'server-a', label: 'Server A' }]} />,
    );

    await user.click(view.getByRole('button', { name: 'New Playlist' }));

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });

  it('hides the ownership filter while every playlist is personal', () => {
    const view = renderWithProviders(
      <HeaderHarness ownershipCounts={{ personal: 4, sharedByMe: 0, sharedWithMe: 0 }} />,
    );

    expect(view.queryByRole('group', { name: 'Playlists by owner' })).not.toBeInTheDocument();
  });

  it('keeps the filter reachable when the last shared playlist disappears', () => {
    // The selection is persisted. Hiding the control here too would strand the
    // user on an empty list with no way to clear it — and it would survive a
    // restart.
    usePlaylistLayoutStore.getState().setOwnershipFilter('sharedWithMe');
    const view = renderWithProviders(
      <HeaderHarness ownershipCounts={{ personal: 4, sharedByMe: 0, sharedWithMe: 0 }} />,
    );

    expect(view.getByRole('group', { name: 'Playlists by owner' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });

  it('shows the ownership filter once something is shared', () => {
    const view = renderWithProviders(
      <HeaderHarness ownershipCounts={{ personal: 4, sharedByMe: 0, sharedWithMe: 1 }} />,
    );

    const group = view.getByRole('group', { name: 'Playlists by owner' });
    expect(group).toBeInTheDocument();
    for (const name of ['All', 'Personal', 'Shared by me', 'Shared with me']) {
      expect(view.getByRole('button', { name })).toBeInTheDocument();
    }
    // `all` is the default, and the pressed state is what a screen reader reads out.
    expect(view.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByRole('button', { name: 'Personal' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('moves the pressed state to the bucket the user picks', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <HeaderHarness ownershipCounts={{ personal: 2, sharedByMe: 1, sharedWithMe: 3 }} />,
    );

    await user.click(view.getByRole('button', { name: 'Shared with me' }));

    expect(view.getByRole('button', { name: 'Shared with me' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });
});
