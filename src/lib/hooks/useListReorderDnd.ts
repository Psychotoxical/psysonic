import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import type { ListReorderDropTarget } from '@/lib/util/listReorder';

interface Options {
  /** Payload discriminator the drag source emits, e.g. `'lyrics_source_reorder'`. */
  type: string;
  /**
   * Apply the move. Receives the dragged row id and the resolved drop target.
   * Consumers own the actual list mutation (store-specific). Memoise this
   * (`useCallback`) so the drop listener does not re-bind every render.
   */
  apply: (draggedId: string, target: ListReorderDropTarget) => void;
}

interface Result {
  isDragging: boolean;
  /** Attach to the rows' container: `ref={setContainer}`. */
  setContainer: (el: HTMLElement | null) => void;
  /** Attach to the rows' container: `onMouseMove={onMouseMove}`. */
  onMouseMove: (e: React.MouseEvent) => void;
  /** Which edge (if any) of row `id` should show the drop indicator. */
  dropEdge: (id: string) => 'before' | 'after' | null;
}

/**
 * Drag-to-reorder wiring shared by the customizer panels. Tracks the hovered
 * drop target, listens for the `psy-drop` event, and resolves the target by
 * **stable id** (read from `data-reorder-id`, with optional
 * `data-reorder-section`). The actual reorder is delegated to `apply`, keeping
 * this hook list-agnostic. Pair with `ReorderGripHandle` on each row and
 * `applyListReorderById` (or a section-aware variant) inside `apply`.
 */
export function useListReorderDnd({ type, apply }: Options): Result {
  const { isDragging } = useDragDrop();
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [dropTarget, setDropTarget] = useState<ListReorderDropTarget | null>(null);
  const dropTargetRef = useRef<ListReorderDropTarget | null>(null);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers; not render data.
  // eslint-disable-next-line react-hooks/refs
  dropTargetRef.current = dropTarget;

  // Clear the drop indicator as soon as any drag ends.
  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with the drag input.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isDragging]);

  useEffect(() => {
    if (!container) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; id?: string; section?: string };
      try { parsed = JSON.parse(detail.data as string); } catch { return; }
      if (parsed.type !== type || !parsed.id) return;

      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);
      if (!target) return;
      apply(parsed.id, target);
    };
    container.addEventListener('psy-drop', onPsyDrop);
    return () => container.removeEventListener('psy-drop', onPsyDrop);
  }, [container, type, apply]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !container) return;
    const rows = container.querySelectorAll<HTMLElement>('[data-reorder-id]');
    let target: ListReorderDropTarget | null = null;
    for (const row of rows) {
      const id = row.dataset.reorderId;
      if (!id) continue;
      const section = row.dataset.reorderSection;
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target = section ? { id, before, section } : { id, before };
      if (before) break;
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  }, [isDragging, container]);

  const dropEdge = useCallback((id: string): 'before' | 'after' | null => {
    if (!isDragging || dropTarget?.id !== id) return null;
    return dropTarget.before ? 'before' : 'after';
  }, [isDragging, dropTarget]);

  return { isDragging, setContainer, onMouseMove, dropEdge };
}
