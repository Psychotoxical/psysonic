import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import SidebarLibraryPicker from '@/features/sidebar/components/SidebarLibraryPicker';
import { DragDropProvider } from '@/lib/dnd/DragDropContext';
import type { SyncStateDto } from '@/lib/api/library/dto';

const folders = [
  { id: 'lib-a', name: 'Rock' },
  { id: 'lib-b', name: 'Jazz' },
  { id: 'lib-c', name: 'Classical' },
];

async function flushAnimationFrame(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function renderPicker(
  over: Partial<ComponentProps<typeof SidebarLibraryPicker>> = {},
) {
  const onSelectionChange = vi.fn();
  const setLibraryDropdownOpen = vi.fn();
  const props = {
    selectedLibraryIds: [] as string[],
    selectionSummary: null as string | null,
    libraryDropdownOpen: true,
    setLibraryDropdownOpen,
    dropdownRect: { top: 0, left: 0, width: 240 },
    libraryTriggerRef: createRef<HTMLButtonElement>(),
    musicFolders: folders,
    onSelectionChange,
    ...over,
  };

  const renderResult = renderWithProviders(
    <DragDropProvider>
      <SidebarLibraryPicker {...props} />
    </DragDropProvider>,
  );

  return { onSelectionChange, setLibraryDropdownOpen, props, ...renderResult };
}

function readyStatus(serverId: string): SyncStateDto {
  return {
    serverId,
    libraryScope: '',
    syncPhase: 'ready',
    capabilityFlags: 0,
    libraryTier: 'full',
  };
}

const multiServers = [
  {
    id: 'server-a',
    label: 'Home',
    selected: true,
    folders: folders.slice(0, 2),
    selectedLibraryIds: [],
    status: readyStatus('server-a'),
    connection: 'online' as const,
    excludedReasons: [],
  },
  {
    id: 'server-b',
    label: 'Remote',
    selected: true,
    folders: folders.slice(1),
    selectedLibraryIds: ['lib-b'],
    status: readyStatus('server-b'),
    connection: 'online' as const,
    excludedReasons: [],
  },
];

describe('SidebarLibraryPicker', () => {
  it('shows the folder name when exactly one library is selected', () => {
    renderPicker({
      selectedLibraryIds: ['lib-b'],
      selectionSummary: 'Jazz',
      libraryDropdownOpen: false,
    });

    expect(screen.getByText('Jazz')).toBeInTheDocument();
  });

  it('shows the multi-library count summary', () => {
    renderPicker({
      selectedLibraryIds: ['lib-a', 'lib-c'],
      selectionSummary: '2 libraries',
      libraryDropdownOpen: false,
    });

    expect(screen.getByText('2 libraries')).toBeInTheDocument();
  });

  it('clears the selection when All libraries is chosen', async () => {
    const user = userEvent.setup();
    const { onSelectionChange, setLibraryDropdownOpen } = renderPicker({
      selectedLibraryIds: ['lib-a'],
    });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'All libraries' }));
    await flushAnimationFrame();

    expect(onSelectionChange).toHaveBeenCalledWith([]);
    expect(setLibraryDropdownOpen).toHaveBeenCalledWith(false);
  });

  it('exclusive-selects one library when its label is clicked', async () => {
    const user = userEvent.setup();
    const { onSelectionChange, setLibraryDropdownOpen } = renderPicker({
      selectedLibraryIds: ['lib-a', 'lib-b'],
    });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Classical' }));
    await flushAnimationFrame();

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-c']);
    expect(setLibraryDropdownOpen).toHaveBeenCalledWith(false);
  });

  it('toggles a library on from the all-libraries state', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderPicker({ selectedLibraryIds: [] });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Include Jazz' }));

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-b']);
  });

  it('appends a toggled-on library to the ordered selection', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderPicker({ selectedLibraryIds: ['lib-a'] });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Include Jazz' }));

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-a', 'lib-b']);
  });

  it('removes a toggled-off library from the selection', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderPicker({ selectedLibraryIds: ['lib-a', 'lib-b'] });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Exclude Rock' }));

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-b']);
  });

  it('selects servers and prevents deselecting the final selected server', async () => {
    const user = userEvent.setup();
    const onServerSelectionChange = vi.fn();
    renderPicker({
      servers: [
        multiServers[0],
        { ...multiServers[1], selected: false },
      ],
      onServerSelectionChange,
    });

    const home = screen.getByRole('checkbox', { name: 'Home' });
    const remote = screen.getByRole('checkbox', { name: 'Remote' });
    expect(home).toBeDisabled();
    expect(remote).toBeEnabled();

    await user.click(remote);
    expect(onServerSelectionChange).toHaveBeenCalledWith('server-b', true);
  });

  it('uses per-server All libraries and ordered multi-select controls', async () => {
    const user = userEvent.setup();
    const onServerLibrarySelectionChange = vi.fn();
    renderPicker({ servers: multiServers, onServerLibrarySelectionChange });

    const homeLibraries = screen.getByRole('group', { name: 'Libraries on Home' });
    expect(within(homeLibraries).getByRole('checkbox', { name: 'All libraries' })).toBeChecked();
    await user.click(within(homeLibraries).getByRole('checkbox', { name: 'Jazz' }));
    expect(onServerLibrarySelectionChange).toHaveBeenCalledWith('server-a', ['lib-b']);

    await user.click(screen.getByRole('button', { name: 'Show libraries for Remote' }));
    const remoteLibraries = screen.getByRole('group', { name: 'Libraries on Remote' });
    await user.click(within(remoteLibraries).getByRole('checkbox', { name: 'Classical' }));
    expect(onServerLibrarySelectionChange).toHaveBeenCalledWith(
      'server-b',
      ['lib-b', 'lib-c'],
    );
    await user.click(within(remoteLibraries).getByRole('checkbox', { name: 'All libraries' }));
    expect(onServerLibrarySelectionChange).toHaveBeenCalledWith('server-b', []);
  });

  it('shows last-known folders and explains offline and not-ready exclusions', async () => {
    const user = userEvent.setup();
    renderPicker({
      servers: [
        {
          ...multiServers[0],
          connection: 'offline',
          excludedReasons: ['offline'],
        },
        {
          ...multiServers[1],
          status: { ...readyStatus('server-b'), syncPhase: 'initial_sync' },
          excludedReasons: ['index_not_ready'],
        },
      ],
    });

    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Not in browse: offline')).toBeInTheDocument();
    expect(screen.getByText('Indexing')).toBeInTheDocument();
    expect(screen.getByText('Not in browse: index not ready')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Rock' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Show libraries for Remote' }));
    expect(screen.getByRole('checkbox', { name: 'Classical' })).toBeEnabled();
  });

  it('reorders the common server list with keyboard-accessible controls', async () => {
    const user = userEvent.setup();
    const onServersReorder = vi.fn();
    renderPicker({ servers: multiServers, onServersReorder });

    expect(screen.getByRole('button', { name: 'Move Home up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Remote up' }));
    expect(onServersReorder).toHaveBeenCalledWith(['server-b', 'server-a']);
  });

  it('exposes the multi-server picker as a labelled dialog with expandable groups', async () => {
    const user = userEvent.setup();
    renderPicker({ servers: multiServers });

    expect(screen.getByRole('dialog', { name: 'Library scope' })).toBeInTheDocument();
    const remoteToggle = screen.getByRole('button', { name: 'Show libraries for Remote' });
    expect(remoteToggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(remoteToggle);
    expect(screen.getByRole('button', { name: 'Hide libraries for Remote' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Libraries on Remote' })).toBeInTheDocument();
  });

  it('moves focus into the dialog, contains Tab, closes on Escape, and restores the trigger', async () => {
    const user = userEvent.setup();
    const { setLibraryDropdownOpen, rerender, props } = renderPicker({ servers: multiServers });
    const trigger = screen.getByRole('button', { name: 'Library scope' });
    trigger.focus();

    const firstCheckbox = screen.getByRole('checkbox', { name: 'Home' });
    await waitFor(() => expect(firstCheckbox).toHaveFocus());
    const lastButton = screen.getByRole('button', { name: 'Show libraries for Remote' });
    lastButton.focus();
    await user.tab();
    expect(firstCheckbox).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(setLibraryDropdownOpen).toHaveBeenCalledWith(false);
    rerender(
      <DragDropProvider>
        <SidebarLibraryPicker {...props} servers={multiServers} libraryDropdownOpen={false} />
      </DragDropProvider>,
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('announces readable server status changes and uses viewport-safe dialog structure', () => {
    renderPicker({ servers: multiServers });

    const dialog = screen.getByRole('dialog', { name: 'Library scope' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('nav-library-server-panel');
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Online');
  });
});
