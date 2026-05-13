import React, { useEffect, useRef, useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { useDragDrop } from '../contexts/DragDropContext';
import { usePlayerStore } from '../store/playerStore';

interface Args {
  queueOpen: boolean;
  miniQueueWrapRef: React.RefObject<HTMLDivElement | null>;
  queueScrollRef: React.RefObject<HTMLDivElement | null>;
  fallbackQueueLen: number;
}

/** Mini-player queue drag/drop wiring. Mirrors QueuePanel's pattern but with
 *  no external sources — psy-drop on the scroll viewport emits mini:reorder,
 *  psy-drop outside the wrap emits mini:remove. The reorder math collapses
 *  same-position drops and adjusts for index-shift after removing the source. */
export function useMiniQueueDrag({
  queueOpen, miniQueueWrapRef, queueScrollRef, fallbackQueueLen,
}: Args) {
  const { isDragging: isPsyDragging, startDrag, payload: psyPayload } = useDragDrop();
  const psyDragFromIdxRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ idx: number; before: boolean } | null>(null);
  const dropTargetRef = useRef<{ idx: number; before: boolean } | null>(null);

  const isReorderDrag = isPsyDragging && !!psyPayload && (() => {
    try { return JSON.parse(psyPayload.data).type === 'queue_reorder'; } catch { return false; }
  })();

  useEffect(() => {
    if (!isPsyDragging) {
      dropTargetRef.current = null;
      setDropTarget(null);
    }
  }, [isPsyDragging]);

  // psy-drop inside the queue strip → mini:reorder.
  // queueOpen must be in deps because the wrap (and thus queueScrollRef.current)
  // only mounts when the queue is expanded — without it the ref is null on
  // first run and the listener never attaches.
  useEffect(() => {
    if (!queueOpen) return;
    const el = queueScrollRef.current;
    if (!el) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: any = null;
      try { parsed = JSON.parse(detail.data); } catch { return; }
      const tgt = dropTargetRef.current;
      dropTargetRef.current = null;
      setDropTarget(null);
      if (parsed.type !== 'queue_reorder') return;
      const fromIdx = parsed.index as number;
      psyDragFromIdxRef.current = null;
      const queueLen = usePlayerStore.getState().queue.length || fallbackQueueLen;
      const insertIdx = tgt
        ? (tgt.before ? tgt.idx : tgt.idx + 1)
        : queueLen;
      if (fromIdx === insertIdx || fromIdx === insertIdx - 1) return;
      const adjusted = fromIdx < insertIdx ? insertIdx - 1 : insertIdx;
      if (fromIdx === adjusted) return;
      emit('mini:reorder', { from: fromIdx, to: adjusted }).catch(() => {});
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [queueOpen, fallbackQueueLen, queueScrollRef]);

  // Drop outside the mini queue strip → mini:remove (same UX as main QueuePanel).
  useEffect(() => {
    if (!queueOpen) return;
    const onDocPsyDrop = (e: Event) => {
      const d = (e as CustomEvent<{ data?: string; clientX?: number; clientY?: number }>).detail;
      if (!d?.data) return;
      const cx = d.clientX;
      const cy = d.clientY;
      if (typeof cx !== 'number' || typeof cy !== 'number') return;
      let parsed: { type?: string; index?: number } | null = null;
      try {
        parsed = JSON.parse(d.data);
      } catch {
        return;
      }
      if (parsed?.type !== 'queue_reorder' || typeof parsed.index !== 'number') return;
      const wrap = miniQueueWrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const inside =
        cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      if (inside) return;
      psyDragFromIdxRef.current = null;
      dropTargetRef.current = null;
      setDropTarget(null);
      emit('mini:remove', { index: parsed.index }).catch(() => {});
    };
    document.addEventListener('psy-drop', onDocPsyDrop);
    return () => document.removeEventListener('psy-drop', onDocPsyDrop);
  }, [queueOpen, miniQueueWrapRef]);

  return {
    isReorderDrag,
    psyDragFromIdxRef,
    dropTarget,
    setDropTarget,
    dropTargetRef,
    startDrag,
  };
}
