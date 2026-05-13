import React, { useEffect, useLayoutEffect } from 'react';
import { registerQueueListScrollTopReader, consumePendingQueueListScrollTop } from '../store/queueUndo';
import type { Track } from '../store/playerStoreTypes';

interface Args {
  queue: Track[];
  queueIndex: number;
  currentTrack: Track | null;
  activeTab: string;
  queueListRef: React.RefObject<HTMLDivElement | null>;
  suppressNextAutoScrollRef: React.MutableRefObject<boolean>;
}

/** Queue auto-scroll: keeps the next track in view as playback progresses,
 *  publishes the list's scrollTop to the undo store, and restores any pending
 *  scrollTop snapshot (set when an undo restores a prior queue state). */
export function useQueueAutoScroll({
  queue, queueIndex, currentTrack, activeTab, queueListRef, suppressNextAutoScrollRef,
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

  useEffect(function queueAutoScroll() {
    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }
    if (!queueListRef.current || queueIndex < 0) return;
    if (activeTab !== 'queue') return;
    const songs = queueListRef.current!.querySelectorAll<HTMLElement>('[data-queue-idx]');
    const nextSong = songs[queueIndex + 1];
    if (!nextSong) return;
    nextSong.scrollIntoView({ block: 'start', behavior: 'instant' });
    requestAnimationFrame(() => {
      queueListRef.current?.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack, activeTab]);
}
