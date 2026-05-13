import { useEffect, useRef, useState } from 'react';
import {
  Check, FolderOpen, Infinity, MoveRight, Save, Share2, Shuffle, Trash2, Waves,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Track } from '../../store/playerStoreTypes';
import type {
  QueueToolbarButtonConfig,
  QueueToolbarButtonId,
} from '../../store/queueToolbarStore';

interface Props {
  queue: Track[];
  activePlaylist: { id: string; name: string } | null;
  saveState: 'idle' | 'saving' | 'saved';
  toolbarButtons: QueueToolbarButtonConfig[];
  shuffleQueue: () => void;
  handleSave: () => void;
  handleLoad: () => void;
  handleCopyQueueShare: () => void;
  handleClear: () => void;
  gaplessEnabled: boolean;
  setGaplessEnabled: (v: boolean) => void;
  crossfadeEnabled: boolean;
  setCrossfadeEnabled: (v: boolean) => void;
  crossfadeSecs: number;
  setCrossfadeSecs: (v: number) => void;
  infiniteQueueEnabled: boolean;
  setInfiniteQueueEnabled: (v: boolean) => void;
  t: TFunction;
}

export function QueueToolbar({
  queue, activePlaylist, saveState, toolbarButtons, shuffleQueue,
  handleSave, handleLoad, handleCopyQueueShare, handleClear,
  gaplessEnabled, setGaplessEnabled, crossfadeEnabled, setCrossfadeEnabled,
  crossfadeSecs, setCrossfadeSecs, infiniteQueueEnabled, setInfiniteQueueEnabled,
  t,
}: Props) {
  const [showCrossfadePopover, setShowCrossfadePopover] = useState(false);
  const crossfadeBtnRef = useRef<HTMLButtonElement>(null);
  const crossfadePopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showCrossfadePopover) return;
    const handle = (e: MouseEvent) => {
      if (
        crossfadeBtnRef.current?.contains(e.target as Node) ||
        crossfadePopoverRef.current?.contains(e.target as Node)
      ) return;
      setShowCrossfadePopover(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showCrossfadePopover]);

  return (
    <div className="queue-toolbar">
      {toolbarButtons.map((btn) => {
        if (!btn.visible) return null;

        switch (btn.id as QueueToolbarButtonId) {
          case 'shuffle':
            return (
              <button key={btn.id} className="queue-round-btn" onClick={() => shuffleQueue()} disabled={queue.length < 2} data-tooltip={t('queue.shuffle')} aria-label={t('queue.shuffle')}>
                <Shuffle size={13} />
              </button>
            );
          case 'save':
            return (
              <button
                key={btn.id}
                className={`queue-round-btn${saveState === 'saved' ? ' active' : ''}`}
                onClick={handleSave}
                disabled={saveState === 'saving'}
                data-tooltip={activePlaylist ? `${t('queue.updatePlaylist')}: ${activePlaylist.name}` : t('queue.savePlaylist')}
                aria-label={t('queue.savePlaylist')}
              >
                {saveState === 'saved' ? <Check size={13} /> : <Save size={13} />}
              </button>
            );
          case 'load':
            return (
              <button key={btn.id} className="queue-round-btn" onClick={handleLoad} data-tooltip={t('queue.loadPlaylist')} aria-label={t('queue.loadPlaylist')}>
                <FolderOpen size={13} />
              </button>
            );
          case 'share':
            return (
              <button
                key={btn.id}
                className="queue-round-btn"
                onClick={() => void handleCopyQueueShare()}
                data-tooltip={t('queue.shareQueue')}
                aria-label={t('queue.shareQueue')}
              >
                <Share2 size={13} />
              </button>
            );
          case 'clear':
            return (
              <button key={btn.id} className="queue-round-btn" onClick={handleClear} data-tooltip={t('queue.clear')} aria-label={t('queue.clear')}>
                <Trash2 size={13} />
              </button>
            );
          case 'separator':
            return <div key={btn.id} className="queue-toolbar-sep" />;
          case 'gapless':
            return (
              <button
                key={btn.id}
                className={`queue-round-btn${gaplessEnabled ? ' active' : ''}`}
                onClick={() => { setCrossfadeEnabled(false); setShowCrossfadePopover(false); setGaplessEnabled(!gaplessEnabled); }}
                data-tooltip={t('queue.gapless')}
                aria-label={t('queue.gapless')}
              >
                <MoveRight size={13} />
              </button>
            );
          case 'crossfade':
            return (
              <div key={btn.id} style={{ position: 'relative' }}>
                <button
                  ref={crossfadeBtnRef}
                  className={`queue-round-btn${crossfadeEnabled || showCrossfadePopover ? ' active' : ''}`}
                  onClick={() => {
                    if (crossfadeEnabled) {
                      setCrossfadeEnabled(false);
                      setShowCrossfadePopover(false);
                    } else {
                      setGaplessEnabled(false);
                      setCrossfadeEnabled(true);
                      setShowCrossfadePopover(true);
                    }
                  }}
                  data-tooltip={showCrossfadePopover ? undefined : t('queue.crossfade')}
                  aria-label={t('queue.crossfade')}
                >
                  <Waves size={13} />
                </button>
                {showCrossfadePopover && (
                  <div className="crossfade-popover" ref={crossfadePopoverRef}>
                    <div className="crossfade-popover-label">
                      <Waves size={11} />
                      {t('queue.crossfade')}
                      <span className="crossfade-popover-value">{crossfadeSecs.toFixed(1)} s</span>
                    </div>
                    <input
                      type="range"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={crossfadeSecs}
                      onChange={e => {
                        setCrossfadeSecs(parseFloat(e.target.value));
                        setCrossfadeEnabled(true);
                      }}
                      className="crossfade-popover-slider"
                    />
                    <div className="crossfade-popover-range">
                      <span>0.1s</span><span>10s</span>
                    </div>
                  </div>
                )}
              </div>
            );
          case 'infinite':
            return (
              <button
                key={btn.id}
                className={`queue-round-btn${infiniteQueueEnabled ? ' active' : ''}`}
                onClick={() => setInfiniteQueueEnabled(!infiniteQueueEnabled)}
                data-tooltip={t('queue.infiniteQueue')}
                aria-label={t('queue.infiniteQueue')}
              >
                <Infinity size={13} />
              </button>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
