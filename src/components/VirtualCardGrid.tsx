import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useElementClientHeightById } from '../hooks/useResizeClientHeight';
import { useCardGridMetrics } from '../hooks/useCardGridMetrics';
import { useRemeasureGridVirtualizer } from '../hooks/useRemeasureGridVirtualizer';
import { useVirtualizerScrollMargin } from '../hooks/useVirtualizerScrollMargin';
import type { CardGridRowHeightVariant } from '../utils/cardGridLayout';

export type VirtualCardGridProps<T> = {
  items: readonly T[];
  itemKey: (item: T, flatIndex: number) => string;
  renderItem: (item: T) => React.ReactNode;
  rowVariant: CardGridRowHeightVariant;
  disableVirtualization: boolean;
  /** Bumps layout when list shape changes (e.g. `items.length`). */
  layoutSignal: number;
  wrapClassName?: string;
  /** Optional styles on the outer measurement wrapper (e.g. enter animation). */
  wrapStyle?: React.CSSProperties;
  /** Defaults to `var(--space-4)`; composer grid uses `var(--space-2)`. */
  gridGap?: string;
};

/**
 * Album-/playlist-style card grids: at most six columns, proportional stretch,
 * optional row virtualization with scroll root `#APP_MAIN_SCROLL_VIEWPORT_ID`.
 */
export function VirtualCardGrid<T>({
  items,
  itemKey,
  renderItem,
  rowVariant,
  disableVirtualization,
  layoutSignal,
  wrapClassName = 'album-grid-wrap',
  wrapStyle,
  gridGap = 'var(--space-4)',
}: VirtualCardGridProps<T>): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { gridCols, rowHeightEst } = useCardGridMetrics(wrapRef, true, rowVariant, layoutSignal);
  const cols = Math.max(1, gridCols);
  const virtualRowCount = Math.max(0, Math.ceil(items.length / cols));
  const mainScrollViewportHeight = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);
  const overscan = Math.max(2, Math.ceil(mainScrollViewportHeight / Math.max(1, rowHeightEst)));

  const scrollMargin = useVirtualizerScrollMargin(
    wrapRef,
    () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    {
      active: !disableVirtualization,
      deps: [layoutSignal, virtualRowCount],
    },
  );

  const virtualizer = useVirtualizer({
    count: disableVirtualization ? 0 : virtualRowCount,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: () => rowHeightEst,
    overscan,
    scrollMargin,
  });

  useRemeasureGridVirtualizer(virtualizer, {
    active: !disableVirtualization && virtualRowCount > 0,
    gridCols: cols,
    rowHeightEst,
    virtualRowCount,
  });

  if (disableVirtualization) {
    return (
      <div
        ref={wrapRef}
        className={wrapClassName}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap: gridGap,
          alignItems: 'start',
          ...wrapStyle,
        }}
      >
        {items.map((item, i) => (
          <React.Fragment key={itemKey(item, i)}>{renderItem(item)}</React.Fragment>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={wrapClassName}
      style={{ display: 'block', position: 'relative', width: '100%', ...wrapStyle }}
    >
      <div
        style={{
          height: virtualRowCount === 0 ? 0 : virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(vRow => {
          const start = vRow.index * cols;
          const rowItems = items.slice(start, start + cols);
          // `vRow.start` is measured from the scroll element's top; our wrapper
          // already sits `scrollMargin` below that, so subtract to land back
          // in wrapper-local coordinates.
          return (
            <div
              key={vRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start - scrollMargin}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: gridGap,
                alignItems: 'start',
              }}
            >
              {rowItems.map((item, i) => (
                <React.Fragment key={itemKey(item, start + i)}>{renderItem(item)}</React.Fragment>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
