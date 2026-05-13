import React from 'react';
import { Play } from 'lucide-react';
import type { TFunction } from 'i18next';
import OverlayScrollArea from '../OverlayScrollArea';
import { usePlayerStore } from '../../store/playerStore';
import { useLuckyMixStore } from '../../store/luckyMixStore';
import type { Track, PlayerState } from '../../store/playerStoreTypes';
import { formatTime } from '../../utils/queuePanelHelpers';

type StartDrag = (
  payload: { data: string; label: string },
  x: number,
  y: number,
) => void;

interface Props {
  queue: Track[];
  queueIndex: number;
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

export function QueueList({
  queue, queueIndex, contextMenu, playTrack, activeTab, queueListRef,
  suppressNextAutoScrollRef, isQueueDrag, psyDragFromIdxRef, externalDropTarget,
  startDrag, orbitAttributionLabel, luckyRolling, t,
}: Props) {
  return (
    <OverlayScrollArea
      viewportRef={queueListRef}
      className="queue-list-wrap"
      viewportClassName="queue-list"
      measureDeps={[activeTab, queue.length]}
      railInset="panel"
      viewportScrollBehaviorAuto={isQueueDrag}
    >
      {queue.length === 0 ? (
        <div className="queue-empty">
          {t('queue.emptyQueue')}
        </div>
      ) : (
        <>
        {queue.map((track, idx) => {
          const isPlaying = idx === queueIndex;
          const isFirstAutoAdded = track.autoAdded && (idx === 0 || !queue[idx - 1].autoAdded);
          const isFirstRadioAdded = track.radioAdded && (idx === 0 || !queue[idx - 1].radioAdded);

          let dragStyle: React.CSSProperties = {};
          if (isQueueDrag && psyDragFromIdxRef.current === idx) {
            dragStyle = { opacity: 0.4, background: 'var(--bg-hover)' };
          } else if (isQueueDrag && externalDropTarget?.idx === idx) {
            if (externalDropTarget.before) {
              dragStyle = { borderTop: '2px solid var(--accent)', paddingTop: '6px', marginTop: '-2px' };
            } else {
              dragStyle = { borderBottom: '2px solid var(--accent)', paddingBottom: '6px', marginBottom: '-2px' };
            }
          }

          return (
            <React.Fragment key={`${track.id}-${idx}`}>
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
              data-queue-idx={idx}
              className={`queue-item ${isPlaying ? 'active' : ''} ${contextMenu.isOpen && contextMenu.type === 'queue-item' && contextMenu.queueIndex === idx ? 'context-active' : ''}`}
              onClick={() => {
                suppressNextAutoScrollRef.current = true;
                // Pass the row index so a click on a duplicate track lands on
                // *this* slot, not the first occurrence (issue #500).
                playTrack(track, queue, undefined, undefined, idx);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                usePlayerStore.getState().openContextMenu(e.clientX, e.clientY, track, 'queue-item', idx);
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
                    psyDragFromIdxRef.current = idx;
                    startDrag({ data: JSON.stringify({ type: 'queue_reorder', index: idx }), label: track.title }, me.clientX, me.clientY);
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
                {formatTime(track.duration)}
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
            </React.Fragment>
          );
        })}
        </>
      )}
    </OverlayScrollArea>
  );
}
