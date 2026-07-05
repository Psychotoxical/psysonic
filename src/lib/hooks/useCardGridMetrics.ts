import { useLayoutEffect, useState, type RefObject } from 'react';
import { useAuthStore } from '@/store/authStore';
import { clampLibraryGridMaxColumns } from '@/store/authStoreHelpers';
import {
  type CardGridRowHeightVariant,
  computeCardGridColumnCount,
  computeCellWidthPx,
  estimateRowHeightPx,
} from '@/lib/util/cardGridLayout';

/**
 * ResizeObserver-driven column count (capped by Settings → Library) and
 * virtual row height estimate from the measured cell width.
 */
export function useCardGridMetrics(
  measureRef: RefObject<HTMLElement | null>,
  observerEnabled: boolean,
  variant: CardGridRowHeightVariant,
  layoutSignal: number,
): { gridCols: number; rowHeightEst: number } {
  const maxCols = useAuthStore(s => clampLibraryGridMaxColumns(s.libraryGridMaxColumns));
  const [gridCols, setGridCols] = useState(4);
  const [rowHeightEst, setRowHeightEst] = useState(() =>
    estimateRowHeightPx(
      computeCellWidthPx(960, clampLibraryGridMaxColumns(useAuthStore.getState().libraryGridMaxColumns)),
      variant,
    ),
  );

  useLayoutEffect(() => {
    if (!observerEnabled) return;
    const el = measureRef.current;
    if (!el) return;
    const onResize = () => {
      const w = el.clientWidth;
      const cols = computeCardGridColumnCount(w, maxCols);
      setGridCols(cols);
      setRowHeightEst(estimateRowHeightPx(computeCellWidthPx(w, cols), variant));
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [observerEnabled, variant, layoutSignal, maxCols, measureRef]);

  return { gridCols, rowHeightEst };
}
