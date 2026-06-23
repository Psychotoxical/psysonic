import { useEffect, useRef, useState } from 'react';
import {
  Blend, Check, FolderOpen, Infinity as InfinityIcon, ListMusic, MoveRight, Save, Share2, Shuffle, Trash2, Waves,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type { QueueItemRef } from '../../store/playerStoreTypes';
import type {
  QueueToolbarButtonConfig,
  QueueToolbarButtonId,
} from '../../store/queueToolbarStore';
import { getTransitionMode, setTransitionMode } from '../../utils/playback/playbackTransition';
import { useOrbitStore } from '../../store/orbitStore';

interface Props {
  queue: QueueItemRef[];
  activePlaylist: { id: string; name: string } | null;
  saveState: 'idle' | 'saving' | 'saved';
  toolbarButtons: QueueToolbarButtonConfig[];
  shuffleQueue: () => void;
  handleSave: () => void;
  handleLoad: () => void;
  handleCopyQueueShare: () => void;
  handleClear: () => void;
  gaplessEnabled: boolean;
  crossfadeEnabled: boolean;
  crossfadeTrimSilence: boolean;
  crossfadeSecs: number;
  setCrossfadeSecs: (v: number) => void;
  infiniteQueueEnabled: boolean;
  setInfiniteQueueEnabled: (v: boolean) => void;
  t: TFunction;
}

export function QueueToolbar({
  queue, activePlaylist, saveState, toolbarButtons, shuffleQueue,
  handleSave, handleLoad, handleCopyQueueShare, handleClear,
  gaplessEnabled, crossfadeEnabled, crossfadeTrimSilence,
  crossfadeSecs, setCrossfadeSecs,
  infiniteQueueEnabled, setInfiniteQueueEnabled,
  t,
}: Props) {
  const [showCrossfadePopover, setShowCrossfadePopover] = useState(false);
  const [showPlaylistMenu, setShowPlaylistMenu] = useState(false);
  const crossfadeBtnRef = useRef<HTMLButtonElement>(null);
  const crossfadePopoverRef = useRef<HTMLDivElement>(null);
  const playlistBtnRef = useRef<HTMLButtonElement>(null);
  const playlistMenuRef = useRef<HTMLDivElement>(null);

  const mode = getTransitionMode({ gaplessEnabled, crossfadeEnabled, crossfadeTrimSilence });
  // Transitions are host-controlled while a guest in a live session — disable
  // the quick-toggles so the user can't fight the per-tick sync.
  const transitionsLocked = useOrbitStore(
    s => s.role === 'guest' && (s.phase === 'active' || s.phase === 'joining'),
  );
  const transitionLockTip = transitionsLocked ? t('settings.transitionsHostControlled') : undefined;

  useEffect(() => {
    if (!showCrossfadePopover && !showPlaylistMenu) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        showCrossfadePopover &&
        !crossfadeBtnRef.current?.contains(target) &&
        !crossfadePopoverRef.current?.contains(target)
      ) setShowCrossfadePopover(false);
      if (
        showPlaylistMenu &&
        !playlistBtnRef.current?.contains(target) &&
        !playlistMenuRef.current?.contains(target)
      ) setShowPlaylistMenu(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showCrossfadePopover, showPlaylistMenu]);

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
          case 'playlist':
            return (
              <div key={btn.id} style={{ position: 'relative' }}>
                <button
                  ref={playlistBtnRef}
                  className={`queue-round-btn${showPlaylistMenu ? ' active' : ''}`}
                  onClick={() => { setShowCrossfadePopover(false); setShowPlaylistMenu(v => !v); }}
                  data-tooltip={showPlaylistMenu ? undefined : t('queue.playlist')}
                  aria-label={t('queue.playlist')}
                >
                  <ListMusic size={13} />
                </button>
                {showPlaylistMenu && (
                  <div className="crossfade-popover queue-menu" ref={playlistMenuRef}>
                    <button
                      type="button"
                      className="queue-menu-item"
                      onClick={() => { handleSave(); setShowPlaylistMenu(false); }}
                      disabled={saveState === 'saving'}
                    >
                      {saveState === 'saved' ? <Check size={14} /> : <Save size={14} />}
                      {activePlaylist ? `${t('queue.updatePlaylist')}: ${activePlaylist.name}` : t('queue.savePlaylist')}
                    </button>
                    <button
                      type="button"
                      className="queue-menu-item"
                      onClick={() => { handleLoad(); setShowPlaylistMenu(false); }}
                    >
                      <FolderOpen size={14} />
                      {t('queue.loadPlaylist')}
                    </button>
                  </div>
                )}
              </div>
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
                className={`queue-round-btn${mode === 'gapless' ? ' active' : ''}`}
                onClick={() => { setShowCrossfadePopover(false); setTransitionMode(mode === 'gapless' ? 'none' : 'gapless'); }}
                disabled={transitionsLocked}
                data-tooltip={transitionLockTip ?? t('queue.gapless')}
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
                  className={`queue-round-btn${mode === 'crossfade' || showCrossfadePopover ? ' active' : ''}`}
                  onClick={() => {
                    // Left click toggles classic crossfade on/off. Right click
                    // opens the seconds popover.
                    setShowPlaylistMenu(false);
                    setTransitionMode(mode === 'crossfade' ? 'none' : 'crossfade');
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setShowPlaylistMenu(false);
                    setShowCrossfadePopover(v => !v);
                  }}
                  disabled={transitionsLocked}
                  data-tooltip={transitionLockTip ?? (showCrossfadePopover ? undefined : t('queue.crossfade'))}
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
                        setTransitionMode('crossfade');
                      }}
                      className="crossfade-popover-slider"
                      aria-label={t('queue.crossfade')}
                    />
                    <div className="crossfade-popover-range">
                      <span>0.1s</span><span>10s</span>
                    </div>
                  </div>
                )}
              </div>
            );
          case 'autodj':
            return (
              <button
                key={btn.id}
                className={`queue-round-btn${mode === 'autodj' ? ' active' : ''}`}
                onClick={() => { setShowCrossfadePopover(false); setShowPlaylistMenu(false); setTransitionMode(mode === 'autodj' ? 'none' : 'autodj'); }}
                disabled={transitionsLocked}
                data-tooltip={transitionLockTip ?? t('queue.autoDj')}
                aria-label={t('queue.autoDj')}
              >
                <Blend size={13} />
              </button>
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
                <InfinityIcon size={13} />
              </button>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
