import React, { useEffect, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Play } from 'lucide-react';
import type { TFunction } from 'i18next';
import OverlayScrollArea from '../OverlayScrollArea';
import { usePlayerStore } from '../../store/playerStore';
import { useLuckyMixStore } from '../../store/luckyMixStore';
import type { QueueItemRef, PlayerState } from '../../store/playerStoreTypes';
import type { QueueDisplayMode } from '../../store/authStoreTypes';
import { formatTrackTime } from '../../utils/format/formatDuration';
import { resolveQueueTrack } from '../../utils/library/queueTrackView';
import {
  getQueueResolverVersion,
  subscribeQueueResolver,
} from '../../utils/library/queueTrackResolver';

type StartDrag = (
  payload: { data: string; label: string },
  x: number,
  y: number,
) => void;

interface Props {
  /** The rows to render. In queue mode this is the upcoming-only slice of the
   *  canonical queue; in playlist mode it is the full queue. */
  queue: QueueItemRef[];
  /** Absolute index of the currently playing track in the canonical queue. */
  queueIndex: number;
  /** Absolute index of `queue[0]` in the canonical queue (0 in playlist mode,
   *  `queueIndex + 1` in queue mode). Added to a row's local index to recover
   *  its absolute index for play / context-menu / drag / reorder. */
  displayBaseIndex: number;
  queueDisplayMode: QueueDisplayMode;
  /** Label for the empty list (differs between "queue is empty" and "no
   *  upcoming tracks"). */
  emptyLabel: string;
  contextMenu: PlayerState['contextMenu'];
  playTrack: PlayerState['playTrack'];
  activeTab: string;
  queueListRef: React.RefObject<HTMLDivElement | null>;
  suppressNextAutoScrollRef: React.MutableRefObject<boolean>;
  isQueueDrag: boolean;
  psyDragFromIdxRef: React.MutableRefObject<number | null>;
  externalDropTarget: { idx: number; before: boolean } | null;
  startDrag: StartDrag;
  orbitAttributionLabel: (trackId: string) => string | null;
  luckyRolling: boolean;
  t: TFunction;
}

// Stable reference so the virtualizer never sees a "changed" option on re-render
// (an inline object literal would be a new ref every render). Only used until the
// ResizeObserver reports the real viewport height.
const INITIAL_RECT = { width: 0, height: 600 };

export function QueueList({
  queue, queueIndex, displayBaseIndex, queueDisplayMode, emptyLabel,
  contextMenu, playTrack, activeTab, queueListRef,
  suppressNextAutoScrollRef, isQueueDrag, psyDragFromIdxRef, externalDropTarget,
  startDrag, orbitAttributionLabel, luckyRolling, t,
}: Props) {
  // Thin-state: the queue prop is the canonical `QueueItemRef[]`. Each row's
  // full Track comes from the resolver (cache → placeholder; F4 overrides merged
  // in resolveQueueTrack). Subscribe once so the list re-renders as the cache
  // fills. Pure read in render — no cache mutation (the freeze landmine).
  useSyncExternalStore(subscribeQueueResolver, getQueueResolverVersion);

  // Virtualize so a 10k+ Artist-Radio queue keeps DOM at O(visible rows).
  // Scroll element is the OverlayScrollArea viewport (`queueListRef`); rows have
  // variable height (radio/auto dividers, lucky-mix loader) so we measure them.
  // React Compiler incompatible-library rule: third-party hook/value the compiler cannot analyze; usage is correct.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: queue.length,
    getScrollElement: () => queueListRef.current,
    estimateSize: () => 52,
    overscan: 10,
    getItemKey: i => `${queue[i].trackId}:${i}`,
    // Start with a sensible viewport height so rows render before the
    // ResizeObserver reports the real size (SSR / jsdom, where the observer
    // never fires). The real height overrides this on first measure.
    initialRect: INITIAL_RECT,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Auto-scroll on track change (and on mode toggle). Honours the suppression
  // flag (row click / undo restore). Two-step where it scrolls: the virtualizer
  // brings the target row into the rendered range (estimate-based, can land a
  // few px off), then scrollIntoView snaps it flush at the top (exact).
  useEffect(() => {
    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }
    if (activeTab !== 'queue' || queueIndex < 0 || queue.length === 0) return;

    const pinToTop = (localIndex: number, absIndex: number) => {
      rowVirtualizer.scrollToIndex(localIndex, { align: 'start' });
      const id = requestAnimationFrame(() => {
        const el = queueListRef.current?.querySelector<HTMLElement>(`[data-queue-idx="${absIndex}"]`);
        el?.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
      return () => cancelAnimationFrame(id);
    };

    if (queueDisplayMode === 'queue') {
      // Upcoming-only: the next track is the first row — keep it pinned at the
      // top. The played track already dropped out of the slice.
      return pinToTop(0, displayBaseIndex);
    }

    if (queueDisplayMode === 'timeline') {
      // Anchor the current track in the middle — history above, up-next below.
      rowVirtualizer.scrollToIndex(queueIndex, { align: 'center' });
      const id = requestAnimationFrame(() => {
        const el = queueListRef.current?.querySelector<HTMLElement>(`[data-queue-idx="${queueIndex}"]`);
        el?.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      return () => cancelAnimationFrame(id);
    }

    // Playlist: lazy. Let the highlight wander while the now-playing row stays
    // visible; only re-pin it to the top once it has scrolled out of view.
    const viewport = queueListRef.current;
    if (viewport) {
      const rowEl = viewport.querySelector<HTMLElement>(`[data-queue-idx="${queueIndex}"]`);
      if (rowEl) {
        const rowRect = rowEl.getBoundingClientRect();
        const viewRect = viewport.getBoundingClientRect();
        const fullyVisible = rowRect.top >= viewRect.top && rowRect.bottom <= viewRect.bottom;
        if (fullyVisible) return; // highlight just moved within view — don't yank
      }
    }
    return pinToTop(queueIndex, queueIndex);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIndex, activeTab, queueDisplayMode]);

  return (
    <OverlayScrollArea
      viewportRef={queueListRef}
      className="queue-list-wrap"
      viewportClassName="queue-list"
      measureDeps={[activeTab, queue.length, totalSize]}
      railInset="panel"
      viewportScrollBehaviorAuto={isQueueDrag}
    >
      {queue.length === 0 ? (
        <div className="queue-empty">
          {emptyLabel}
        </div>
      ) : (
        <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {virtualItems.map(vi => {
          const idx = vi.index;
          // Local index addresses `queue` (the displayed slice); the absolute
          // index addresses the canonical queue and drives every handler that
          // mutates / selects (play, context menu, drag, reorder, drop target).
          const absIdx = displayBaseIndex + idx;
          const base = queue[idx];
          const track = resolveQueueTrack(base);
          const isPlaying = absIdx === queueIndex;
          const isTimeline = queueDisplayMode === 'timeline';
          const isPast = isTimeline && absIdx < queueIndex;
          const isFirstAutoAdded = base.autoAdded && (idx === 0 || !queue[idx - 1].autoAdded);
          const isFirstRadioAdded = base.radioAdded && (idx === 0 || !queue[idx - 1].radioAdded);

          let dragStyle: React.CSSProperties = {};
          if (isQueueDrag && psyDragFromIdxRef.current === absIdx) {
            dragStyle = { opacity: 0.4, background: 'var(--bg-hover)' };
          } else if (isQueueDrag && externalDropTarget?.idx === absIdx) {
            if (externalDropTarget.before) {
              dragStyle = { borderTop: '2px solid var(--accent)', paddingTop: '6px', marginTop: '-2px' };
            } else {
              dragStyle = { borderBottom: '2px solid var(--accent)', paddingBottom: '6px', marginBottom: '-2px' };
            }
          }

          return (
            <div
              key={vi.key}
              data-index={idx}
              ref={rowVirtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
            >
            {isTimeline && idx === 0 && queueIndex > 0 && (
              <div className="queue-divider" style={{ margin: '2px 0' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{t('queue.history')}</span>
              </div>
            )}
            {isTimeline && absIdx === queueIndex + 1 && (
              <div className="queue-divider" style={{ margin: '2px 0' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{t('queue.upNext')}</span>
              </div>
            )}
            {isFirstRadioAdded && (
              <div className="queue-divider" style={{ margin: '2px 0' }}>
                <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)' }}>{t('queue.radioAdded')}</span>
              </div>
            )}
            {isFirstAutoAdded && (
              <div className="queue-divider" style={{ margin: '2px 0' }}>
                <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)' }}>{t('queue.autoAdded')}</span>
              </div>
            )}
            <div
              data-queue-idx={absIdx}
              className={`queue-item ${isPlaying ? 'active' : ''} ${contextMenu.isOpen && contextMenu.type === 'queue-item' && contextMenu.queueIndex === absIdx ? 'context-active' : ''}`}
              onClick={() => {
                suppressNextAutoScrollRef.current = true;
                // Same-queue jump: undefined keeps the canonical refs; the row
                // index lands a click on a duplicate track on *this* slot, not
                // the first occurrence (issue #500).
                playTrack(track, undefined, undefined, undefined, absIdx);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                usePlayerStore.getState().openContextMenu(e.clientX, e.clientY, track, 'queue-item', absIdx);
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                const startX = e.clientX;
                const startY = e.clientY;
                const onMove = (me: MouseEvent) => {
                  if (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5) {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    psyDragFromIdxRef.current = absIdx;
                    startDrag({ data: JSON.stringify({ type: 'queue_reorder', index: absIdx }), label: track.title }, me.clientX, me.clientY);
                  }
                };
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
              style={{ ...(isPast && !isPlaying ? { opacity: 0.5 } : null), ...dragStyle }}
            >
              <div className="queue-item-info">
                <div className="queue-item-title truncate" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {isPlaying && <Play size={10} fill="currentColor" style={{ flexShrink: 0 }} />}
                  <span className="truncate">{track.title}</span>
                </div>
                <div className="queue-item-artist truncate">{track.artist}</div>
                {(() => {
                  const label = orbitAttributionLabel(track.id);
                  return label ? <div className="queue-item-attribution truncate">{label}</div> : null;
                })()}
              </div>
              <div className="queue-item-duration">
                {formatTrackTime(track.duration)}
              </div>
            </div>
            {luckyRolling && isPlaying && (
              <button
                type="button"
                className="queue-lucky-loading"
                onClick={() => useLuckyMixStore.getState().cancel()}
                data-tooltip={t('luckyMix.cancelTooltip')}
                aria-label={t('luckyMix.cancelTooltip')}
              >
                <div className="queue-lucky-loading__dice">
                  <div className="queue-lucky-cube queue-lucky-cube--a">
                    <span className="lucky-mix-pip lucky-mix-pip--tl" />
                    <span className="lucky-mix-pip lucky-mix-pip--tr" />
                    <span className="lucky-mix-pip lucky-mix-pip--bl" />
                    <span className="lucky-mix-pip lucky-mix-pip--br" />
                  </div>
                  <div className="queue-lucky-cube queue-lucky-cube--b">
                    <span className="lucky-mix-pip lucky-mix-pip--center" />
                  </div>
                  <div className="queue-lucky-cube queue-lucky-cube--c">
                    <span className="lucky-mix-pip lucky-mix-pip--tl" />
                    <span className="lucky-mix-pip lucky-mix-pip--center" />
                    <span className="lucky-mix-pip lucky-mix-pip--br" />
                  </div>
                </div>
              </button>
            )}
            </div>
          );
        })}
        </div>
      )}
    </OverlayScrollArea>
  );
}
