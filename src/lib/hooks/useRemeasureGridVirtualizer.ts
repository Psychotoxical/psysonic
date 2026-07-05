import { useEffect } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

/** When grid column count or row height estimate changes, TanStack can keep stale offsets until scroll — force a remeasure. */
export function useRemeasureGridVirtualizer<TScroll extends Element, TItem extends Element>(
  virtualizer: Virtualizer<TScroll, TItem>,
  args: {
    active: boolean;
    gridCols: number;
    rowHeightEst: number;
    virtualRowCount: number;
  },
): void {
  useEffect(() => {
    if (!args.active || args.virtualRowCount === 0) return;
    virtualizer.measure();
  }, [
    args.active,
    args.gridCols,
    args.rowHeightEst,
    args.virtualRowCount,
    virtualizer,
  ]);
}
