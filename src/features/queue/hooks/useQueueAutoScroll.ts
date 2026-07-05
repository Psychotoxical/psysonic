import React, { useLayoutEffect } from 'react';
import { registerQueueListScrollTopReader, consumePendingQueueListScrollTop } from '@/features/playback/store/queueUndo';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';

interface Args {
  queue: QueueItemRef[];
  queueIndex: number;
  currentTrack: Track | null;
  queueListRef: React.RefObject<HTMLDivElement | null>;
  suppressNextAutoScrollRef: React.MutableRefObject<boolean>;
}

/** Queue scroll-position bridge for undo: publishes the list's scrollTop to the
 *  undo store and restores any pending scrollTop snapshot (set when an undo
 *  restores a prior queue state). The "scroll the next track into view" path
 *  lives in `QueueList` now that the list is virtualized (scrollToIndex). */
export function useQueueAutoScroll({
  queue, queueIndex, currentTrack, queueListRef, suppressNextAutoScrollRef,
}: Args) {
  useLayoutEffect(() => {
    registerQueueListScrollTopReader(() => queueListRef.current?.scrollTop);
    return () => registerQueueListScrollTopReader(null);
  }, [queueListRef]);

  useLayoutEffect(() => {
    const top = consumePendingQueueListScrollTop();
    if (top === undefined) return;
    const el = queueListRef.current;
    if (!el) return;
    suppressNextAutoScrollRef.current = true;
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll', { bubbles: false }));
  }, [queue, queueIndex, currentTrack?.id, queueListRef, suppressNextAutoScrollRef]);
}
