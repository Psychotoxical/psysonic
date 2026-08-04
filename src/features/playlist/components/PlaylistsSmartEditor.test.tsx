import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import PlaylistsSmartEditor from '@/features/playlist/components/PlaylistsSmartEditor';
import { defaultSmartFilters } from '@/features/playlist/utils/playlistsSmart';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

function SmartEditorHarness({
  editingSmartId,
  serverOptions = [
    { id: 'server-a', label: 'Server A' },
    { id: 'server-b', label: 'Server B' },
  ],
}: {
  editingSmartId: string | null;
  serverOptions?: Array<{ id: string; label: string }>;
}) {
  const [filters, setFilters] = useState({
    ...defaultSmartFilters,
    selectedGenres: [...defaultSmartFilters.selectedGenres],
  });
  const [serverId, setServerId] = useState('server-a');

  return (
    <PlaylistsSmartEditor
      smartFilters={filters}
      setSmartFilters={setFilters}
      availableGenres={[]}
      genreQuery=""
      setGenreQuery={vi.fn()}
      editingSmartId={editingSmartId}
      creatingSmartBusy={false}
      genresReady
      createServerId={serverId}
      setCreateServerId={setServerId}
      createServerOptions={serverOptions}
      setCreatingSmart={vi.fn()}
      setEditingSmartId={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />
  );
}

describe('PlaylistsSmartEditor', () => {
  it('shows the target server while creating a smart playlist', () => {
    const view = renderWithProviders(<SmartEditorHarness editingSmartId={null} />);

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    expect(view.getByRole('combobox', { name: 'Servers' })).toHaveTextContent('Server A');
  });

  it('keeps the owner server fixed while editing a smart playlist', () => {
    const view = renderWithProviders(<SmartEditorHarness editingSmartId="smart-1" />);

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });

  it('hides the owner selector when creating in single-server mode', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId={null}
        serverOptions={[{ id: 'server-a', label: 'Server A' }]}
      />,
    );

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });
});
