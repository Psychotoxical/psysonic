import { useRef, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PlaylistsHeader from '@/features/playlist/components/PlaylistsHeader';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

function HeaderHarness({
  createServerOptions = [
    { id: 'server-a', label: 'Server A' },
    { id: 'server-b', label: 'Server B' },
  ],
}: {
  createServerOptions?: Array<{ id: string; label: string }>;
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
      />
      {creatingSmart && <div data-testid="smart-editor-open" />}
      <div data-testid="selected-server">{serverId}</div>
    </>
  );
}

describe('PlaylistsHeader', () => {
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
});
