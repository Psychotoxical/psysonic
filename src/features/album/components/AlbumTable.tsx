import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import type { AlbumBrowseSort } from '@/lib/library/albumBrowseSort';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import { albumGridWarmCovers, COVER_TRACK_ROW_CSS_PX } from '@/cover/layoutSizes';
import { ALBUM_TABLE_ROW_HEIGHT_PX } from '@/lib/util/cardGridLayout';
import AlbumTableRow from './AlbumTableRow';

/** Sort keys the table's clickable headers drive, when the page has them. */
export interface AlbumTableSortControl {
  value: AlbumBrowseSort;
  onChange: (sort: AlbumBrowseSort) => void;
}

interface AlbumTableProps {
  albums: SubsonicAlbum[];
  itemKey: (album: SubsonicAlbum) => string;
  scrollRootId: string;
  disableVirtualization: boolean;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (album: SubsonicAlbum, opts?: { shiftKey?: boolean }) => void;
  selectedAlbums: SubsonicAlbum[];
  /** Appended to `/album/:id`, e.g. `lossless=1`. */
  linkQuery?: string;
  /**
   * Omit on pages without a sort control (New Releases) — headers then render
   * as static labels rather than promising an order the page cannot deliver.
   */
  sort?: AlbumTableSortControl;
}

function SortableHeader({
  label,
  sortKey,
  sort,
}: {
  label: string;
  sortKey: AlbumBrowseSort;
  sort?: AlbumTableSortControl;
}) {
  if (!sort) return <>{label}</>;
  // Ascending is the only direction the browse sorts offer, so an active header
  // is `ascending` and every other one is `none` — never a toggle that would
  // suggest a descending order the index cannot produce. Composite sorts
  // (artist → year) mark no header: they are not what a single column means.
  const active = sort.value === sortKey;
  return (
    <button
      type="button"
      className={`album-table__sort-btn${active ? ' album-table__sort-btn--active' : ''}`}
      onClick={() => sort.onChange(sortKey)}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

/**
 * Metadata table for the album catalogue pages, virtualised through the shared
 * card grid pinned to one item per row. The header sits outside the virtualiser
 * (which positions its rows absolutely) and stays stuck to the top of the
 * page's scroll viewport.
 */
export default function AlbumTable({
  albums,
  itemKey,
  scrollRootId,
  disableVirtualization,
  selectionMode,
  selectedIds,
  onToggleSelect,
  selectedAlbums,
  linkQuery,
  sort,
}: AlbumTableProps) {
  const { t } = useTranslation();

  // Virtual rows only receive their item, so the position each row reports as
  // `aria-rowindex` is looked up here — without it a screen reader would count
  // only the handful of rows currently mounted.
  const rowIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    albums.forEach((album, i) => map.set(itemKey(album), i + 2));
    return map;
  }, [albums, itemKey]);

  const sortedByTitle = sort?.value === 'alphabeticalByName';
  const sortedByArtist = sort?.value === 'alphabeticalByArtist';

  return (
    <div
      className="album-table"
      role="table"
      aria-label={t('albums.tableLabel')}
      aria-rowcount={albums.length + 1}
      style={{ ['--album-table-row-height' as string]: `${ALBUM_TABLE_ROW_HEIGHT_PX}px` }}
    >
      <div className="album-table__header album-table__grid" role="row" aria-rowindex={1}>
        <span className="album-table__cell album-table__cell--cover" role="columnheader">
          <span className="visually-hidden">{t('albums.columnCover')}</span>
        </span>
        <span
          className="album-table__cell album-table__cell--title"
          role="columnheader"
          aria-sort={sort ? (sortedByTitle ? 'ascending' : 'none') : undefined}
        >
          <SortableHeader label={t('albums.columnTitle')} sortKey="alphabeticalByName" sort={sort} />
        </span>
        <span
          className="album-table__cell album-table__cell--artist"
          role="columnheader"
          aria-sort={sort ? (sortedByArtist ? 'ascending' : 'none') : undefined}
        >
          <SortableHeader label={t('albums.columnArtist')} sortKey="alphabeticalByArtist" sort={sort} />
        </span>
        <span className="album-table__cell album-table__cell--songs" role="columnheader">
          {t('albums.columnSongs')}
        </span>
        <span className="album-table__cell album-table__cell--year" role="columnheader">
          {t('albums.columnYear')}
        </span>
        <span className="album-table__cell album-table__cell--duration" role="columnheader">
          {t('albums.columnDuration')}
        </span>
        <span className="album-table__cell album-table__cell--added" role="columnheader">
          {t('albums.columnAdded')}
        </span>
      </div>

      <VirtualCardGrid
        items={albums}
        itemKey={(a, _i) => itemKey(a)}
        rowVariant="albumTableRow"
        singleColumn
        presentationalWrappers
        gridGap="0"
        wrapClassName="album-table__body"
        disableVirtualization={disableVirtualization}
        layoutSignal={albums.length}
        scrollRootId={scrollRootId}
        warmGridCovers={albumGridWarmCovers(COVER_TRACK_ROW_CSS_PX)}
        renderItem={a => (
          <AlbumTableRow
            album={a}
            rowIndex={rowIndexByKey.get(itemKey(a)) ?? 2}
            selectionMode={selectionMode}
            selected={selectedIds.has(itemKey(a))}
            onToggleSelect={opts => onToggleSelect(a, opts)}
            selectedAlbums={selectedAlbums}
            linkQuery={linkQuery}
            observeScrollRootId={scrollRootId}
          />
        )}
      />
    </div>
  );
}
