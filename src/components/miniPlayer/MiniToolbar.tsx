import React from 'react';
import { createPortal } from 'react-dom';
import { emit } from '@tauri-apps/api/event';
import { Infinity as InfinityIcon, ListMusic, MoveRight, Shuffle, Volume2, VolumeX, Waves } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { MiniSyncPayload } from '../../utils/miniPlayerBridge';

interface Props {
  state: MiniSyncPayload;
  volume: number;
  volumeOpen: boolean;
  setVolumeOpen: (updater: boolean | ((v: boolean) => boolean)) => void;
  volumeBtnRef: React.RefObject<HTMLButtonElement | null>;
  volumePopRef: React.RefObject<HTMLDivElement | null>;
  volumePopStyle: React.CSSProperties;
  handleVolumeChange: (v: number) => void;
  toggleMute: () => void;
  queueOpen: boolean;
  toggleQueue: () => void;
  t: TFunction;
}

export function MiniToolbar({
  state, volume, volumeOpen, setVolumeOpen, volumeBtnRef, volumePopRef, volumePopStyle,
  handleVolumeChange, toggleMute, queueOpen, toggleQueue, t,
}: Props) {
  return (
    <div className="mini-player__toolbar" data-tauri-drag-region="false">
      <div className="mini-player__volume-wrap">
        <button
          ref={volumeBtnRef}
          type="button"
          className={`mini-player__tool${volumeOpen ? ' mini-player__tool--active' : ''}`}
          onClick={() => setVolumeOpen(v => !v)}
          onContextMenu={(e) => { e.preventDefault(); toggleMute(); }}
          data-tauri-drag-region="false"
          data-tooltip={volume === 0 ? t('player.volume') : `${t('player.volume')} ${Math.round(volume * 100)}%`}
          aria-label={t('player.volume')}
        >
          {volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        {volumeOpen && createPortal(
          <div
            ref={volumePopRef}
            className="mini-player__volume-popover"
            style={volumePopStyle}
            data-tauri-drag-region="false"
          >
            <span className="mini-player__volume-pct">{Math.round(volume * 100)}%</span>
            <div
              className="mini-player__volume-bar"
              role="slider"
              aria-label={t('player.volume')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(volume * 100)}
              onMouseDown={(e) => {
                const target = e.currentTarget;
                const setFromY = (clientY: number) => {
                  const rect = target.getBoundingClientRect();
                  const ratio = 1 - (clientY - rect.top) / rect.height;
                  handleVolumeChange(ratio);
                };
                setFromY(e.clientY);
                const onMove = (me: MouseEvent) => setFromY(me.clientY);
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
              onWheel={(e) => {
                e.preventDefault();
                handleVolumeChange(volume + (e.deltaY > 0 ? -0.05 : 0.05));
              }}
            >
              <div
                className="mini-player__volume-bar-fill"
                style={{ height: `${Math.round(volume * 100)}%` }}
              />
            </div>
          </div>,
          document.body,
        )}
      </div>

      <button
        type="button"
        className="mini-player__tool"
        onClick={() => emit('mini:shuffle').catch(() => {})}
        disabled={state.queue.length < 2}
        data-tauri-drag-region="false"
        data-tooltip={t('queue.shuffle')}
        aria-label={t('queue.shuffle')}
      >
        <Shuffle size={13} />
      </button>

      <span className="mini-player__toolbar-sep" aria-hidden />

      <button
        type="button"
        className={`mini-player__tool${state.gaplessEnabled ? ' mini-player__tool--active' : ''}`}
        onClick={() => emit('mini:set-gapless', { value: !state.gaplessEnabled }).catch(() => {})}
        data-tauri-drag-region="false"
        data-tooltip={t('queue.gapless')}
        aria-label={t('queue.gapless')}
      >
        <MoveRight size={13} />
      </button>

      <button
        type="button"
        className={`mini-player__tool${state.crossfadeEnabled ? ' mini-player__tool--active' : ''}`}
        onClick={() => emit('mini:set-crossfade', { value: !state.crossfadeEnabled }).catch(() => {})}
        data-tauri-drag-region="false"
        data-tooltip={t('queue.crossfade')}
        aria-label={t('queue.crossfade')}
      >
        <Waves size={13} />
      </button>

      <button
        type="button"
        className={`mini-player__tool${state.infiniteQueueEnabled ? ' mini-player__tool--active' : ''}`}
        onClick={() => emit('mini:set-infinite-queue', { value: !state.infiniteQueueEnabled }).catch(() => {})}
        data-tauri-drag-region="false"
        data-tooltip={t('queue.infiniteQueue')}
        aria-label={t('queue.infiniteQueue')}
      >
        <InfinityIcon size={13} />
      </button>

      <span className="mini-player__toolbar-sep" aria-hidden />

      <button
        type="button"
        className={`mini-player__tool${queueOpen ? ' mini-player__tool--active' : ''}`}
        onClick={toggleQueue}
        data-tauri-drag-region="false"
        data-tooltip={queueOpen ? t('miniPlayer.hideQueue') : t('miniPlayer.showQueue')}
        aria-label={queueOpen ? t('miniPlayer.hideQueue') : t('miniPlayer.showQueue')}
      >
        <ListMusic size={13} />
      </button>
    </div>
  );
}
