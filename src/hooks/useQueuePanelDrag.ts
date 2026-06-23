import React, { useEffect, useRef, useState } from 'react';
import { resolveAlbum, resolveMediaServerId } from '../utils/offline/offlineMediaResolve';
import { songToTrack } from '../utils/playback/songToTrack';
import { useDragDrop, registerQueueDragHitTest } from '../contexts/DragDropContext';
import { usePlayerStore } from '../store/playerStore';
import type { Track } from '../store/playerStoreTypes';

/** Drag types that may be dropped into the queue panel. */
const QUEUE_DROP_TYPES = new Set(['song', 'album', 'queue_reorder']);

interface Args {
  asideRef: React.RefObject<HTMLElement | null>;
  isQueueVisible: boolean;
  reorderQueue: (from: number, to: number) => void;
  enqueueAt: (tracks: Track[], idx: number) => void;
  removeTrack: (idx: number) => void;
}

/** Queue drag/drop wiring: hit-test registration, psy-drop dispatch for drops
 *  inside the panel, removal-on-drop-outside, and visual feedback refs. */
export function useQueuePanelDrag({
  asideRef, isQueueVisible, reorderQueue, enqueueAt, removeTrack,
}: Args) {
  const psyDragFromIdxRef = useRef<number | null>(null);
  const [externalDropTarget, setExternalDropTarget] = useState<{ idx: number; before: boolean } | null>(null);
  const externalDropTargetRef = useRef<{ idx: number; before: boolean } | null>(null);

  const { isDragging: isPsyDragging, startDrag, payload: psyPayload } = useDragDrop();
  const isQueueDrag = isPsyDragging && !!psyPayload && (() => {
    try { return QUEUE_DROP_TYPES.has(JSON.parse(psyPayload.data).type); } catch { return false; }
  })();

  useEffect(() => {
    const hitTest = (cx: number, cy: number) => {
      const el = asideRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    return registerQueueDragHitTest(hitTest);
  }, [asideRef]);

  useEffect(() => {
    if (!isPsyDragging) {
      externalDropTargetRef.current = null;
      // React Compiler set-state-in-effect rule: state set from a DOM/layout measurement.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExternalDropTarget(null);
    }
  }, [isPsyDragging]);

  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;

    const onPsyDrop = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;

      let parsedData: {
        type?: string;
        index?: number;
        track?: Track;
        tracks?: Track[];
        serverId?: string;
        id?: string;
      };
      try { parsedData = JSON.parse(detail.data); } catch { return; }

      // Radio streams are not tracks — reject silently
      if (parsedData.type === 'radio') return;

      const dropTarget = externalDropTargetRef.current;
      externalDropTargetRef.current = null;
      setExternalDropTarget(null);

      const insertIdx = dropTarget
        ? (dropTarget.before ? dropTarget.idx : dropTarget.idx + 1)
        : usePlayerStore.getState().queueItems.length;

      if (parsedData.type === 'queue_reorder') {
        const fromIdx = parsedData.index as number;
        psyDragFromIdxRef.current = null;
        if (fromIdx !== insertIdx) reorderQueue(fromIdx, insertIdx);
      } else if (parsedData.type === 'song') {
        enqueueAt([parsedData.track as Track], insertIdx);
      } else if (parsedData.type === 'songs') {
        enqueueAt(parsedData.tracks as Track[], insertIdx);
      } else if (parsedData.type === 'album') {
        const serverId = resolveMediaServerId(parsedData.serverId);
        if (!serverId) return;
        const albumData = await resolveAlbum(serverId, parsedData.id as string);
        if (!albumData) return;
        enqueueAt(albumData.songs.map(songToTrack), insertIdx);
      }
    };

    aside.addEventListener('psy-drop', onPsyDrop);
    return () => aside.removeEventListener('psy-drop', onPsyDrop);
  }, [asideRef, enqueueAt, reorderQueue]);

  // Drag a queue row outside the panel → remove (drop never reaches `aside`).
  useEffect(() => {
    const onDocPsyDrop = (e: Event) => {
      if (!isQueueVisible) return;
      const d = (e as CustomEvent<{ data?: string; clientX?: number; clientY?: number }>).detail;
      if (!d?.data) return;
      const cx = d.clientX;
      const cy = d.clientY;
      if (typeof cx !== 'number' || typeof cy !== 'number') return;
      let parsed: { type?: string; index?: number } | null;
      try {
        parsed = JSON.parse(d.data);
      } catch {
        return;
      }
      if (parsed?.type !== 'queue_reorder' || typeof parsed.index !== 'number') return;
      const aside = asideRef.current;
      if (!aside) return;
      const r = aside.getBoundingClientRect();
      const inside =
        cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      if (inside) return;
      psyDragFromIdxRef.current = null;
      externalDropTargetRef.current = null;
      setExternalDropTarget(null);
      removeTrack(parsed.index);
    };
    document.addEventListener('psy-drop', onDocPsyDrop);
    return () => document.removeEventListener('psy-drop', onDocPsyDrop);
  }, [asideRef, isQueueVisible, removeTrack]);

  return {
    psyDragFromIdxRef,
    externalDropTarget,
    externalDropTargetRef,
    setExternalDropTarget,
    isPsyDragging,
    isQueueDrag,
    startDrag,
  };
}
