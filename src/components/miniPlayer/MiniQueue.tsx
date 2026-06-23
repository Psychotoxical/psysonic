import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TFunction } from 'i18next';
import OverlayScrollArea from '../OverlayScrollArea';
import type { MiniSyncPayload, MiniTrackInfo } from '../../utils/miniPlayerBridge';

// Stable initial rect so the virtualizer never re-initializes on re-render (an
// inline literal would be a new ref each render → render loop). Replaced by the
// real height on first ResizeObserver measure.
const MINI_QUEUE_INITIAL_RECT = { width: 0, height: 400 };

type StartDrag = (
  payload: { data: string; label: string },
  x: number,
  y: number,
) => void;

interface Props {
  state: MiniSyncPayload;
  miniQueueWrapRef: React.RefObject<HTMLDivElement | null>;
  queueScrollRef: React.RefObject<HTMLDivElement | null>;
  isReorderDrag: boolean;
  psyDragFromIdxRef: React.MutableRefObject<number | null>;
  dropTarget: { idx: number; before: boolean } | null;
  setDropTarget: (t: { idx: number; before: boolean } | null) => void;
  dropTargetRef: React.MutableRefObject<{ idx: number; before: boolean } | null>;
  startDrag: StartDrag;
  ctxIndex: number | null;
  setCtxMenu: (m: { x: number; y: number; track: MiniTrackInfo; index: number } | null) => void;
  jumpTo: (index: number) => void;
  t: TFunction;
}

export function MiniQueue({
  state, miniQueueWrapRef, queueScrollRef, isReorderDrag, psyDragFromIdxRef,
  dropTarget, setDropTarget, dropTargetRef, startDrag, ctxIndex, setCtxMenu,
  jumpTo, t,
}: Props) {
  // Virtualize so a multi-thousand-track queue keeps the mini window's DOM at
  // O(visible rows). Scroll element is the OverlayScrollArea viewport.
  // React Compiler incompatible-library rule: third-party hook/value the compiler cannot analyze; usage is correct.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: state.queue.length,
    getScrollElement: () => queueScrollRef.current,
    estimateSize: () => 40,
    overscan: 10,
    getItemKey: i => `${state.queue[i].id}:${i}`,
    initialRect: MINI_QUEUE_INITIAL_RECT,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <OverlayScrollArea
      wrapRef={miniQueueWrapRef}
      viewportRef={queueScrollRef}
      className="mini-queue-wrap"
      viewportClassName="mini-queue"
      measureDeps={[state.queue.length, totalSize]}
      railInset="mini"
      viewportScrollBehaviorAuto={isReorderDrag}
      onMouseMove={(e) => {
        if (!isReorderDrag || !queueScrollRef.current) return;
        const items = queueScrollRef.current.querySelectorAll<HTMLElement>('[data-mq-idx]');
        for (let i = 0; i < items.length; i++) {
          const r = items[i].getBoundingClientRect();
          if (e.clientY >= r.top && e.clientY <= r.bottom) {
            const before = e.clientY < r.top + r.height / 2;
            const idx = parseInt(items[i].dataset.mqIdx!, 10);
            const target = { idx, before };
            dropTargetRef.current = target;
            setDropTarget(target);
            return;
          }
        }
        dropTargetRef.current = null;
        setDropTarget(null);
      }}
    >
      {state.queue.length === 0 ? (
        <div className="mini-queue__empty">{t('miniPlayer.emptyQueue')}</div>
      ) : (
        <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {virtualItems.map(vi => {
          const i = vi.index;
          const track = state.queue[i];
          let dragStyle: React.CSSProperties = {};
          if (isReorderDrag && psyDragFromIdxRef.current === i) {
            dragStyle = { opacity: 0.4 };
          } else if (isReorderDrag && dropTarget?.idx === i) {
            dragStyle = dropTarget.before
              ? { boxShadow: 'inset 0 2px 0 var(--accent)' }
              : { boxShadow: 'inset 0 -2px 0 var(--accent)' };
          }
          return (
            <button
              key={vi.key}
              data-index={i}
              ref={rowVirtualizer.measureElement}
              data-mq-idx={i}
              className={`mini-queue__item${i === state.queueIndex ? ' mini-queue__item--current' : ''}${ctxIndex === i ? ' mini-queue__item--ctx' : ''}`}
              onClick={() => jumpTo(i)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, track, index: i });
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                // Don't start drag while a click would also be valid —
                // the threshold check below upgrades to a drag once
                // the pointer leaves the deadband.
                const startX = e.clientX;
                const startY = e.clientY;
                const onMove = (me: MouseEvent) => {
                  if (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5) {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    psyDragFromIdxRef.current = i;
                    startDrag(
                      { data: JSON.stringify({ type: 'queue_reorder', index: i }), label: track.title },
                      me.clientX,
                      me.clientY,
                    );
                  }
                };
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)`, ...dragStyle }}
            >
              <span className="mini-queue__num">{i + 1}</span>
              <div className="mini-queue__meta">
                <div className="mini-queue__title">{track.title}</div>
                <div className="mini-queue__artist">{track.artist}</div>
              </div>
            </button>
          );
        })}
        </div>
      )}
    </OverlayScrollArea>
  );
}
