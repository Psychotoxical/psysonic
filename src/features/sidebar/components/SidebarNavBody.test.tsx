import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { createRef } from 'react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { DragDropProvider } from '@/lib/dnd/DragDropContext';
import SidebarNavBody from '@/features/sidebar/components/SidebarNavBody';
import type { SidebarLibraryServer } from '@/features/sidebar/components/SidebarLibraryPicker';

const baseProps = () => ({
  isCollapsed: false,
  showLibraryPicker: true,
  selectedLibraryIds: [] as string[],
  selectionSummary: null as string | null,
  libraryDropdownOpen: false,
  setLibraryDropdownOpen: vi.fn(),
  dropdownRect: { top: 0, left: 0, width: 240 },
  libraryTriggerRef: createRef<HTMLButtonElement>(),
  musicFolders: [
    { id: 'lib-a', name: 'Rock' },
    { id: 'lib-b', name: 'Jazz' },
  ],
  onLibrarySelectionChange: vi.fn(),
  libraryServers: [] as SidebarLibraryServer[],
  onLibraryServerSelectionChange: vi.fn(),
  onServerLibrarySelectionChange: vi.fn(),
  onLibraryServersReorder: vi.fn(),
  visibleLibraryConfigs: [],
  visibleSystemConfigs: [],
  playlistsExpanded: false,
  setPlaylistsExpanded: vi.fn(),
  playlists: [],
  playlistsLoading: false,
  newReleasesUnreadCount: 0,
  navDnd: null,
  navDndRowClass: () => '',
  handleNavRowPointerDown: vi.fn(),
  isPlaying: false,
  hasNowPlayingTrack: false,
  nowPlayingAtTop: false,
  hasOfflineContent: false,
  activeJobsCount: 0,
  activePinName: null,
  queuedPinCount: 0,
  cancelAllDownloads: vi.fn(),
  isSyncing: false,
  syncJobDone: 0,
  syncJobSkip: 0,
  syncJobFail: 0,
  syncJobTotal: 0,
});

function renderBody(over: Partial<ReturnType<typeof baseProps>> = {}) {
  renderWithProviders(
    <DragDropProvider>
      <SidebarNavBody {...baseProps()} {...over} />
    </DragDropProvider>,
  );
}

describe('SidebarNavBody library picker gate', () => {
  it('renders the picker when showLibraryPicker is true', () => {
    renderBody({ showLibraryPicker: true });

    expect(screen.getByRole('button', { name: 'Library scope' })).toBeInTheDocument();
  });

  it('shows the section label instead of the picker when showLibraryPicker is false', () => {
    renderBody({ showLibraryPicker: false });

    expect(screen.queryByRole('button', { name: 'Library scope' })).not.toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
  });

  it('hides the picker when the sidebar is collapsed', () => {
    renderBody({ isCollapsed: true, showLibraryPicker: false });

    expect(screen.queryByRole('button', { name: 'Library scope' })).not.toBeInTheDocument();
  });

  it('renders the picker for multiple servers even without multiple active-server folders', () => {
    renderBody({
      musicFolders: [],
      libraryServers: [
        {
          id: 'a', label: 'A', selected: true, folders: [], selectedLibraryIds: [],
          status: null, connection: 'unknown', excludedReasons: ['connection_unknown', 'index_not_ready'],
        },
        {
          id: 'b', label: 'B', selected: false, folders: [], selectedLibraryIds: [],
          status: null, connection: 'unknown', excludedReasons: [],
        },
      ],
    });

    expect(screen.getByRole('button', { name: 'Library scope' })).toBeInTheDocument();
  });
});
