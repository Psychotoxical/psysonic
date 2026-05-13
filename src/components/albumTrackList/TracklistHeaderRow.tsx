import React from 'react';
import type { TFunction } from 'i18next';
import type { ColDef } from '../../utils/useTracklistColumns';
import { CENTERED_COLS, isSortable, type ColKey, type SortKey } from '../../utils/albumTrackListHelpers';

interface Props {
  visibleCols: readonly ColDef[];
  gridStyle: React.CSSProperties;
  sortKey?: SortKey;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: SortKey) => void;
  allSelected: boolean;
  inSelectMode: boolean;
  toggleAll: () => void;
  startResize: (e: React.MouseEvent, colIndex: number, direction: 1 | -1) => void;
  t: TFunction;
}

/**
 * The fixed tracklist header row. Each cell is independently sortable
 * (when the column is in `SORTABLE_COLS` and `onSort` is provided) and
 * resizable via a 6px drop-target along its right edge.
 *
 * The `num` cell additionally hosts the bulk-selection toggle so that
 * shift-click-style ranges anchor against the header.
 */
export function TracklistHeaderRow({
  visibleCols,
  gridStyle,
  sortKey,
  sortDir,
  onSort,
  allSelected,
  inSelectMode,
  toggleAll,
  startResize,
  t,
}: Props) {
  const handleHeaderClick = (key: ColKey | string) => {
    if (!isSortable(key) || !onSort) return;
    onSort(key);
  };

  const renderSortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    return (
      <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
        {sortDir === 'asc' ? '▲' : '▼'}
      </span>
    );
  };

  const renderHeaderCell = (colDef: ColDef, colIndex: number) => {
    const key = colDef.key as ColKey;
    const isLastCol = colIndex === visibleCols.length - 1;
    const isCentered = CENTERED_COLS.has(key);
    const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey as string}`) : '';
    const canSort = isSortable(key) && onSort;
    const isActive = canSort && sortKey === key;

    if (key === 'num') {
      return (
        <div key={key} className="track-num">
          <span
            className={`bulk-check${allSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`}
            onClick={e => { e.stopPropagation(); toggleAll(); }}
            style={{ cursor: 'pointer' }}
          />
          <span className="track-num-number">#</span>
        </div>
      );
    }

    if (key === 'title') {
      const hasNextCol = colIndex + 1 < visibleCols.length;
      return (
        <div
          key={key}
          style={{
            position: 'relative',
            padding: 0,
            margin: 0,
            minWidth: 0,
            overflow: 'hidden',
            cursor: canSort ? 'pointer' : 'default',
            userSelect: 'none',
          }}
          onClick={() => handleHeaderClick(key)}
          className={isActive ? 'tracklist-header-cell-active' : ''}
        >
          <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 12 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isActive ? 600 : 400 }}>{label}</span>
            {canSort && renderSortIndicator(key as SortKey)}
          </div>
          {hasNextCol && (
            <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex + 1, -1)} />
          )}
        </div>
      );
    }

    const isResizable = !isLastCol;
    return (
      <div
        key={key}
        style={{
          position: 'relative',
          padding: 0,
          margin: 0,
          minWidth: 0,
          overflow: 'hidden',
          cursor: canSort ? 'pointer' : 'default',
          userSelect: 'none',
        }}
        onClick={() => handleHeaderClick(key)}
        className={isActive ? 'tracklist-header-cell-active' : ''}
      >
        <div
          style={{
            display: 'flex', width: '100%', height: '100%', alignItems: 'center',
            justifyContent: isCentered ? 'center' : 'flex-start',
            paddingLeft: isCentered ? 0 : 12,
          }}
        >
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isActive ? 600 : 400 }}>{label}</span>
          {canSort && isSortable(key) && renderSortIndicator(key as SortKey)}
        </div>
        {isResizable && (
          <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex, 1)} />
        )}
      </div>
    );
  };

  return (
    <div className="tracklist-header-wrapper">
      <div className="tracklist-header" style={gridStyle}>
        {visibleCols.map((colDef, colIndex) => renderHeaderCell(colDef, colIndex))}
      </div>
    </div>
  );
}
