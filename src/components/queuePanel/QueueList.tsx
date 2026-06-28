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
import { findQueueItemRefIndex } from '../../utils/playback/queueIdentity';
import type { TimelineDisplayRow } from '../../utils/queue/buildTimelineDisplayRows';
import { findTimelineScrollLocalIndex } from '../../utils/queue/buildTimelineDisplayRows';
import { playTimelineHistoryTrack } from '../../utils/queue/playTimelineHistoryTrack';

type StartDrag = (
  payload: { data: string; label: string },
  x: number,
  y: number,
) => void;

interface Props {
  queue: QueueItemRef[];
  /** Timeline virtual rows; when set, `queue` is ignored for rendering. */
  timelineRows?: TimelineDisplayRow[];
  /** Canonical queue for history-row play / context-menu index lookup. */
  canonicalQueue?: QueueItemRef[];
  queueIndex: number;
  displayBaseIndex: number;
  queueDisplayMode: QueueDisplayMode;
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

const INITIAL_RECT = { width: 0, height: 600 };

export function QueueList({
  queue, timelineRows, canonicalQueue, queueIndex, displayBaseIndex, queueDisplayMode, emptyLabel,
  contextMenu, playTrack, activeTab, queueListRef,
  suppressNextAutoScrollRef, isQueueDrag, psyDragFromIdxRef, externalDropTarget,
  startDrag, orbitAttributionLabel, luckyRolling, t,
}: Props) {
  useSyncExternalStore(subscribeQueueResolver, getQueueResolverVersion);

  const usingTimeline = queueDisplayMode === 'timeline' && timelineRows != null;
  const rowCount = usingTimeline ? timelineRows.length : queue.length;

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => queueListRef.current,
    estimateSize: () => 52,
    overscan: 10,
    getItemKey: i => {
      if (usingTimeline) return timelineRows[i]!.key;
      return `${queue[i].trackId}:${i}`;
    },
    initialRect: INITIAL_RECT,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  useEffect(() => {
    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }
    if (activeTab !== 'queue' || rowCount === 0 || !usingTimeline || !timelineRows) return;

    const localIdx = findTimelineScrollLocalIndex(timelineRows);
    if (localIdx == null) return;

    const pinToTop = (index: number, scrollSelector: string) => {
      rowVirtualizer.scrollToIndex(index, { align: 'start' });
      const id = requestAnimationFrame(() => {
        const el = queueListRef.current?.querySelector<HTMLElement>(scrollSelector);
        el?.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
      return () => cancelAnimationFrame(id);
    };

    return pinToTop(localIdx, `[data-timeline-local-idx="${localIdx}"]`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIndex, activeTab, queueDisplayMode, usingTimeline]);

  useEffect(() => {
    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }
    if (activeTab !== 'queue' || rowCount === 0 || usingTimeline) return;

    const pinToTop = (localIndex: number, scrollSelector: string) => {
      rowVirtualizer.scrollToIndex(localIndex, { align: 'start' });
      const id = requestAnimationFrame(() => {
        const el = queueListRef.current?.querySelector<HTMLElement>(scrollSelector);
        el?.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
      return () => cancelAnimationFrame(id);
    };

    if (queueDisplayMode === 'queue') {
      if (queueIndex < 0) return;
      return pinToTop(0, `[data-queue-idx="${displayBaseIndex}"]`);
    }

    if (queueIndex < 0) return;
    const viewport = queueListRef.current;
    if (viewport) {
      const rowEl = viewport.querySelector<HTMLElement>(`[data-queue-idx="${queueIndex}"]`);
      if (rowEl) {
        const rowRect = rowEl.getBoundingClientRect();
        const viewRect = viewport.getBoundingClientRect();
        const fullyVisible = rowRect.top >= viewRect.top && rowRect.bottom <= viewRect.bottom;
        if (fullyVisible) return;
      }
    }
    return pinToTop(queueIndex, `[data-queue-idx="${queueIndex}"]`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIndex, activeTab, queueDisplayMode, rowCount, usingTimeline]);

  const playHistoryRow = (serverId: string, trackId: string) => {
    suppressNextAutoScrollRef.current = true;
    void playTimelineHistoryTrack(serverId, trackId, canonicalQueue);
  };

  const renderTrackRow = (args: {
    track: ReturnType<typeof resolveQueueTrack>;
    absIdx: number | null;
    localIndex: number;
    isPlaying: boolean;
    isPast: boolean;
    isHistory: boolean;
    base?: QueueItemRef;
    dragStyle: React.CSSProperties;
  }) => {
    const { track, absIdx, localIndex, isPlaying, isPast, isHistory, base, dragStyle } = args;
    return (
      <div
        data-timeline-local-idx={localIndex}
        {...(isHistory ? { 'data-timeline-kind': 'history' } : {})}
        {...(absIdx != null ? { 'data-queue-idx': absIdx } : {})}
        className={`queue-item ${isPlaying ? 'active' : ''} ${contextMenu.isOpen && contextMenu.type === (absIdx != null ? 'queue-item' : 'song') && (absIdx != null ? contextMenu.queueIndex === absIdx : contextMenu.item === track) ? 'context-active' : ''}`}
        onClick={() => {
          if (isHistory) {
            playHistoryRow(base?.serverId ?? track.serverId ?? '', track.id);
            return;
          }
          if (absIdx == null) return;
          suppressNextAutoScrollRef.current = true;
          playTrack(track, undefined, undefined, undefined, absIdx);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (isHistory && absIdx == null) {
            usePlayerStore.getState().openContextMenu(e.clientX, e.clientY, track, 'song');
            return;
          }
          if (absIdx == null) return;
          usePlayerStore.getState().openContextMenu(e.clientX, e.clientY, track, 'queue-item', absIdx);
        }}
        onMouseDown={(e) => {
          if (isHistory || absIdx == null) return;
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
    );
  };

  return (
    <OverlayScrollArea
      viewportRef={queueListRef}
      className="queue-list-wrap"
      viewportClassName="queue-list"
      measureDeps={[activeTab, rowCount, totalSize]}
      railInset="panel"
      viewportScrollBehaviorAuto={isQueueDrag}
    >
      {rowCount === 0 ? (
        emptyLabel ? (
          <div className="queue-empty">{emptyLabel}</div>
        ) : null
      ) : (
        <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {virtualItems.map(vi => {
          const idx = vi.index;

          if (usingTimeline && timelineRows) {
            const row = timelineRows[idx]!;
            if (row.kind === 'divider') {
              return (
                <div
                  key={row.key}
                  data-index={idx}
                  data-timeline-local-idx={row.localIndex}
                  ref={rowVirtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  <div className="queue-divider" style={{ margin: '2px 0' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>
                      {t(row.labelKey)}
                    </span>
                  </div>
                </div>
              );
            }

            const base = row.kind === 'history'
              ? { serverId: row.ref.serverId, trackId: row.ref.trackId }
              : row.ref;
            const track = resolveQueueTrack(base);
            const absIdx = row.kind === 'history'
              ? findQueueItemRefIndex(
                canonicalQueue ?? usePlayerStore.getState().queueItems,
                row.ref,
              )
              : row.queueIndex;
            const isPlaying = row.kind === 'current';
            const isPast = row.kind === 'history';
            const prevRow = idx > 0 ? timelineRows[idx - 1] : null;
            const isFirstAutoAdded = row.kind === 'upcoming' && row.ref.autoAdded
              && (prevRow?.kind !== 'upcoming' || !prevRow.ref.autoAdded);
            const isFirstRadioAdded = row.kind === 'upcoming' && row.ref.radioAdded
              && (prevRow?.kind !== 'upcoming' || !prevRow.ref.radioAdded);

            let dragStyle: React.CSSProperties = {};
            if (row.kind !== 'history' && isQueueDrag && psyDragFromIdxRef.current === absIdx) {
              dragStyle = { opacity: 0.4, background: 'var(--bg-hover)' };
            } else if (row.kind !== 'history' && isQueueDrag && externalDropTarget?.idx === absIdx) {
              dragStyle = externalDropTarget.before
                ? { borderTop: '2px solid var(--accent)', paddingTop: '6px', marginTop: '-2px' }
                : { borderBottom: '2px solid var(--accent)', paddingBottom: '6px', marginBottom: '-2px' };
            }

            return (
              <div
                key={row.key}
                data-index={idx}
                ref={rowVirtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
              >
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
                {renderTrackRow({
                  track,
                  absIdx: row.kind === 'history' ? (absIdx >= 0 ? absIdx : null) : absIdx,
                  localIndex: row.localIndex,
                  isPlaying,
                  isPast,
                  isHistory: row.kind === 'history',
                  base,
                  dragStyle,
                })}
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
          }

          const absIdx = displayBaseIndex + idx;
          const base = queue[idx];
          const track = resolveQueueTrack(base);
          const isPlaying = absIdx === queueIndex;
          const isPast = false;
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
            {renderTrackRow({
              track,
              absIdx,
              localIndex: idx,
              isPlaying,
              isPast,
              isHistory: false,
              base,
              dragStyle,
            })}
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
