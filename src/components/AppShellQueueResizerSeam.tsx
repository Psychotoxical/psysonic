import React from 'react';
import type { TFunction } from 'i18next';
import { PanelRight, PanelRightClose } from 'lucide-react';
import { shouldSuppressQueueResizerMouseDown } from '../utils/appShellHelpers';

interface Props {
  isQueueVisible: boolean;
  queueWidth: number;
  queueHandleTop: number | null;
  isMainScrolling: boolean;
  setIsDraggingQueue: React.Dispatch<React.SetStateAction<boolean>>;
  handleQueueHandleMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => void;
  t: TFunction;
}

/**
 * The seam between the main column and the queue panel — a 6px resizer
 * strip and the round resize/toggle handle floating over it. Desktop-only.
 *
 * The strip's mousedown is intentionally elaborate: it has to ignore
 * clicks aimed at the main viewport's overlay scrollbar thumb (which sits
 * inside the resizer's overlap region) and self-heal a stale
 * `is-overlay-scrollbar-thumb-drag` body flag if no thumb is actually
 * dragging. The handle is fixed-positioned and aligned with the sidebar's
 * collapse button so the two visually pair across resizes.
 */
export function AppShellQueueResizerSeam({
  isQueueVisible,
  queueWidth,
  queueHandleTop,
  isMainScrolling,
  setIsDraggingQueue,
  handleQueueHandleMouseDown,
  t,
}: Props) {
  return (
    <>
      <div
        className="resizer resizer-queue"
        onMouseDown={(e) => {
          e.preventDefault();
          if (document.body.classList.contains('is-overlay-scrollbar-thumb-drag')) {
            const activeThumbDrag = document.querySelector('.overlay-scroll__thumb.is-thumb-dragging');
            if (!activeThumbDrag) {
              document.body.classList.remove('is-overlay-scrollbar-thumb-drag');
            } else {
              return;
            }
          }
          if (shouldSuppressQueueResizerMouseDown(e.clientX, e.clientY, queueWidth)) return;
          setIsDraggingQueue(true);
        }}
        style={{
          display: isQueueVisible ? 'block' : 'none',
          right: `${Math.max(0, queueWidth - 3)}px`,
        }}
      />
      {isQueueVisible && (
        <button
          type="button"
          className="resizer-queue-handle"
          onMouseDown={handleQueueHandleMouseDown}
          style={{
            position: 'fixed',
            top: queueHandleTop != null ? `${queueHandleTop}px` : '50%',
            right: `${Math.max(0, queueWidth - 11)}px`,
            transform: 'translateY(-50%)',
            zIndex: 101,
            opacity: isMainScrolling ? 0 : 1,
            pointerEvents: isMainScrolling ? 'none' : 'auto',
          }}
          data-tooltip={t('player.collapseQueueResize')}
          data-tooltip-pos="left"
          aria-label={t('player.collapseQueueResize')}
        >
          {isQueueVisible ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
        </button>
      )}
    </>
  );
}
