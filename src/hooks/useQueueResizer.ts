import React, { useCallback, useEffect, useState } from 'react';

interface UseQueueResizerArgs {
  isMobile: boolean;
  isSidebarCollapsed: boolean;
  isQueueVisible: boolean;
  toggleQueue: () => void;
}

interface UseQueueResizerResult {
  queueWidth: number;
  isDraggingQueue: boolean;
  setIsDraggingQueue: React.Dispatch<React.SetStateAction<boolean>>;
  queueHandleTop: number | null;
  handleQueueHandleMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const QUEUE_MIN_WIDTH = 310;
const QUEUE_MAX_WIDTH = 500;
const QUEUE_DEFAULT_WIDTH = 340;
const DRAG_THRESHOLD_PX = 4;

/**
 * State + handlers for the queue panel's vertical resizer:
 *  - `queueWidth` follows the resizer drag (clamped 310..500 px).
 *  - `queueHandleTop` tracks the y-center of the sidebar's collapse button
 *    so the queue handle visually aligns with it across resizes and
 *    sidebar collapse changes.
 *  - `handleQueueHandleMouseDown` distinguishes a click from a drag with a
 *    4-pixel threshold so the handle can both toggle the queue and resize
 *    it without conflicting interaction modes.
 */
export function useQueueResizer({
  isMobile,
  isSidebarCollapsed,
  isQueueVisible,
  toggleQueue,
}: UseQueueResizerArgs): UseQueueResizerResult {
  const [queueWidth, setQueueWidth] = useState(QUEUE_DEFAULT_WIDTH);
  const [isDraggingQueue, setIsDraggingQueue] = useState(false);
  const [queueHandleTop, setQueueHandleTop] = useState<number | null>(null);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingQueue) return;
    const newWidth = Math.max(QUEUE_MIN_WIDTH, Math.min(window.innerWidth - e.clientX, QUEUE_MAX_WIDTH));
    setQueueWidth(newWidth);
  }, [isDraggingQueue]);

  const handleMouseUp = useCallback(() => {
    setIsDraggingQueue(false);
  }, []);

  useEffect(() => {
    if (isDraggingQueue) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.classList.add('is-dragging');
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
      document.body.classList.remove('is-dragging');
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('is-dragging');
    };
  }, [isDraggingQueue, handleMouseMove, handleMouseUp]);

  const syncQueueHandleTop = useCallback(() => {
    const leftBtn = document.querySelector('.sidebar .collapse-btn') as HTMLElement | null;
    if (!leftBtn) return;
    const r = leftBtn.getBoundingClientRect();
    setQueueHandleTop(r.top + r.height / 2);
  }, []);

  useEffect(() => {
    if (isMobile) return;
    const leftBtn = document.querySelector('.sidebar .collapse-btn') as HTMLElement | null;
    if (!leftBtn) return;

    syncQueueHandleTop();
    const raf = requestAnimationFrame(syncQueueHandleTop);

    const onResize = () => syncQueueHandleTop();
    window.addEventListener('resize', onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(leftBtn);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, [isMobile, isSidebarCollapsed, syncQueueHandleTop]);

  const handleQueueHandleMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    let didDrag = false;

    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp, true);
      document.body.style.cursor = '';
      document.body.classList.remove('is-dragging');
    };

    const applyWidthFromClientX = (clientX: number) => {
      const newWidth = Math.max(QUEUE_MIN_WIDTH, Math.min(window.innerWidth - clientX, QUEUE_MAX_WIDTH));
      setQueueWidth(newWidth);
    };

    const onMove = (me: MouseEvent) => {
      const movedEnough = Math.hypot(me.clientX - startX, me.clientY - startY) >= DRAG_THRESHOLD_PX;
      if (!didDrag && movedEnough) {
        didDrag = true;
        if (!isQueueVisible) toggleQueue();
        document.body.style.cursor = 'col-resize';
        document.body.classList.add('is-dragging');
      }
      if (!didDrag) return;
      applyWidthFromClientX(me.clientX);
    };

    const onUp = () => {
      cleanup();
      if (!didDrag) toggleQueue();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, true);
  }, [isQueueVisible, toggleQueue]);

  return { queueWidth, isDraggingQueue, setIsDraggingQueue, queueHandleTop, handleQueueHandleMouseDown };
}
