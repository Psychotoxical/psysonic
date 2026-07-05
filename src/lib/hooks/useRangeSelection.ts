import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Multi-select state with Shift+Click range support.
 *
 * Pass the *currently visible* list (already filtered + sorted in the order
 * the user sees it) so range expansion follows what's on screen, not the
 * raw upstream data.
 *
 * - Plain click on an item: toggles that item and sets it as the new range anchor.
 * - Shift-click on a second item: adds every item between the anchor and the
 *   click target (inclusive) to the selection. The anchor moves to the
 *   shift-clicked item so subsequent shift-clicks extend from there.
 *
 * The anchor is a ref, not state — moving it does not trigger re-renders.
 */
export function useRangeSelection<T extends { id: string }>(items: T[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const anchorRef = useRef<string | null>(null);

  const toggleSelect = useCallback((id: string, opts?: { shiftKey?: boolean }) => {
    // Snapshot the anchor *before* the state updater runs. React strict mode
    // invokes setState updater functions twice in dev to surface side effects,
    // so any ref mutation inside the updater would taint the second invocation
    // and the replay would miss the range branch.
    const anchorAtCallTime = anchorRef.current;
    setSelectedIds(prev => {
      const next = new Set(prev);
      const list = itemsRef.current;

      if (opts?.shiftKey && anchorAtCallTime && anchorAtCallTime !== id) {
        const startIdx = list.findIndex(x => x.id === anchorAtCallTime);
        const endIdx = list.findIndex(x => x.id === id);
        if (startIdx >= 0 && endIdx >= 0) {
          const lo = Math.min(startIdx, endIdx);
          const hi = Math.max(startIdx, endIdx);
          for (let i = lo; i <= hi; i++) {
            next.add(list[i].id);
          }
          return next;
        }
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, []);

  return { selectedIds, setSelectedIds, toggleSelect, clearSelection };
}
