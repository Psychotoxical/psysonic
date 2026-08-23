import { describe, expect, it, vi } from 'vitest';
import type { ColDef } from '@/lib/hooks/useTracklistColumns';
import PlaylistTracklist from '@/features/playlist/components/PlaylistTracklist';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

vi.mock('@/lib/dnd/DragDropContext', () => ({
  useDragDrop: () => ({ isDragging: false, startDrag: vi.fn(), payload: null }),
}));

const columns: ColDef[] = [
  { key: 'num', i18nKey: null, minWidth: 60, defaultWidth: 60, required: true },
  { key: 'title', i18nKey: 'trackTitle', minWidth: 80, defaultWidth: 180, required: true },
];

function renderList(tracksReadOnly: boolean) {
  return renderWithProviders(
    <PlaylistTracklist
      allColumns={columns}
      visibleCols={columns}
      gridStyle={{}}
      colVisible={new Set(['num', 'title'])}
      toggleColumn={vi.fn()}
      resetColumns={vi.fn()}
      pickerOpen={false}
      setPickerOpen={vi.fn()}
      pickerRef={{ current: null }}
      startResize={vi.fn()}
      startFlexColumnResize={vi.fn()}
      tracklistRef={{ current: null }}
      songs={[]}
      displayedSongs={[]}
      displayedTracks={[]}
      isFiltered={false}
      hasActiveFilter={false}
      id="pl-1"
      serverId="srv-a"
      sortKey="natural"
      setSortKey={vi.fn()}
      sortDir="asc"
      setSortDir={vi.fn()}
      sortClickCount={0}
      setSortClickCount={vi.fn()}
      selectedIds={new Set()}
      setSelectedIds={vi.fn()}
      allSelected={false}
      toggleAll={vi.fn()}
      toggleSelect={vi.fn()}
      showBulkPlPicker={false}
      setShowBulkPlPicker={vi.fn()}
      bulkRemove={vi.fn()}
      contextMenuSongId={null}
      setContextMenuSongId={vi.fn()}
      dropTargetIdx={null}
      ratings={{}}
      starredSongs={new Set()}
      handleRate={vi.fn()}
      handleToggleStar={vi.fn()}
      handleRowMouseDown={vi.fn()}
      handleRowMouseEnter={vi.fn()}
      removeSong={vi.fn()}
      setSearchOpen={vi.fn()}
      tracksReadOnly={tracksReadOnly}
    />,
  );
}

describe('PlaylistTracklist read-only smart controls', () => {
  it('hides the add-first-song action when tracks are read-only', () => {
    const view = renderList(true);
    expect(view.getByText('This smart playlist has no matching tracks.')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Add your first song/i })).not.toBeInTheDocument();
  });

  it('keeps the add-first-song action for regular playlists', () => {
    const view = renderList(false);
    expect(view.getByRole('button', { name: /Add your first song/i })).toBeInTheDocument();
  });
});
