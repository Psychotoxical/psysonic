import React from 'react';
import type { TFunction } from 'i18next';
import OverlayScrollArea from '../OverlayScrollArea';
import type { MiniSyncPayload, MiniTrackInfo } from '../../utils/miniPlayerBridge';

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
  return (
    <OverlayScrollArea
      wrapRef={miniQueueWrapRef}
      viewportRef={queueScrollRef}
      className="mini-queue-wrap"
      viewportClassName="mini-queue"
      measureDeps={[state.queue.length]}
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
        state.queue.map((track, i) => {
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
              key={`${track.id}-${i}`}
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
              style={dragStyle}
            >
              <span className="mini-queue__num">{i + 1}</span>
              <div className="mini-queue__meta">
                <div className="mini-queue__title">{track.title}</div>
                <div className="mini-queue__artist">{track.artist}</div>
              </div>
            </button>
          );
        })
      )}
    </OverlayScrollArea>
  );
}
