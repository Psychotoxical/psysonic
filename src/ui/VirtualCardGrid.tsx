import React, { useCallback, useMemo, useRef } from 'react';
import { GRID_COVER_WARM_LIMIT } from '@/cover/layoutSizes';
import { useWarmGridCovers } from '@/cover/useWarmGridCovers';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useElementClientHeightById } from '@/lib/hooks/useResizeClientHeight';
import { useCardGridMetrics } from '@/lib/hooks/useCardGridMetrics';
import { useRemeasureGridVirtualizer } from '@/lib/hooks/useRemeasureGridVirtualizer';
import { useVirtualizerScrollMargin } from '@/lib/hooks/useVirtualizerScrollMargin';
import type { CardGridRowHeightVariant } from '@/lib/util/cardGridLayout';

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
  /** When set, row virtualization uses this scroll container instead of the main route viewport. */
  scrollRootId?: string;
  /** Pre-peek disk WebP for the first viewport of cards (one IPC batch before cells ensure). */
  warmGridCovers?: {
    pickCoverArtId: (item: T) => string | null | undefined;
    displayCssPx: number;
    limit?: number;
  };
};

/**
 * Album-/playlist-style card grids: at most six columns, proportional stretch,
 * optional row virtualization with scroll root `#APP_MAIN_SCROLL_VIEWPORT_ID`
 * (or `scrollRootId` when the grid lives in an in-page overlay viewport).
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
  scrollRootId,
  warmGridCovers,
}: VirtualCardGridProps<T>): React.JSX.Element {
  const warmLimit = warmGridCovers?.limit ?? GRID_COVER_WARM_LIMIT;
  const warmItems = useMemo(() => {
    if (!warmGridCovers) return [];
    return items
      .slice(0, warmLimit)
      .map(item => ({ coverArt: warmGridCovers.pickCoverArtId(item) ?? null }));
  }, [items, warmGridCovers, warmLimit]);
  const warmPeekKey = useMemo(
    () => warmItems.map(i => i.coverArt ?? '').join('\u0001'),
    [warmItems],
  );
  useWarmGridCovers(warmItems, warmGridCovers?.displayCssPx ?? 0, {
    enabled: Boolean(warmGridCovers && warmGridCovers.displayCssPx > 0),
    limit: warmLimit,
    warmKey: warmPeekKey,
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const { gridCols, rowHeightEst } = useCardGridMetrics(wrapRef, true, rowVariant, layoutSignal);
  const cols = Math.max(1, gridCols);
  const virtualRowCount = Math.max(0, Math.ceil(items.length / cols));
  const scrollMetricsElementId = scrollRootId ?? APP_MAIN_SCROLL_VIEWPORT_ID;
  const scrollViewportClientHeight = useElementClientHeightById(scrollMetricsElementId);
  const overscan = Math.max(2, Math.ceil(scrollViewportClientHeight / Math.max(1, rowHeightEst)));

  const getScrollElement = useCallback((): HTMLElement | null => {
    if (scrollRootId) {
      return (
        document.getElementById(scrollRootId) as HTMLElement | null
        ?? (document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null)
      );
    }
    return document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null;
  }, [scrollRootId]);

  const scrollMargin = useVirtualizerScrollMargin(wrapRef, getScrollElement, {
    active: !disableVirtualization,
    deps: [layoutSignal, virtualRowCount, scrollRootId],
  });

  // React Compiler incompatible-library rule: third-party hook/value the compiler cannot analyze; usage is correct.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: disableVirtualization ? 0 : virtualRowCount,
    getScrollElement,
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
