import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { registerQueueDragHitTest } from '../contexts/DragDropContext';
import MiniContextMenu from './MiniContextMenu';
import type { MiniSyncPayload, MiniControlAction, MiniTrackInfo } from '../utils/miniPlayerBridge';
import {
  COLLAPSED_SIZE, EXPANDED_SIZE, COLLAPSED_MIN, EXPANDED_MIN,
  EXPANDED_H_KEY, QUEUE_OPEN_KEY,
  readStoredExpandedHeight, readQueueOpen, initialSnapshot,
} from '../utils/miniPlayerHelpers';
import { MiniTitlebar } from './miniPlayer/MiniTitlebar';
import { MiniMeta } from './miniPlayer/MiniMeta';
import { MiniControls } from './miniPlayer/MiniControls';
import { MiniToolbar } from './miniPlayer/MiniToolbar';
import { MiniQueue } from './miniPlayer/MiniQueue';
import { useMiniVolumePopover } from '../hooks/useMiniVolumePopover';
import { useMiniQueueDrag } from '../hooks/useMiniQueueDrag';
import { useMiniSync } from '../hooks/useMiniSync';
import { useMiniWindowSetup } from '../hooks/useMiniWindowSetup';
import { useMiniKeyboardShortcuts } from '../hooks/useMiniKeyboardShortcuts';

export default function MiniPlayer() {
  const { t } = useTranslation();
  const [state, setState] = useState<MiniSyncPayload>(() => initialSnapshot());
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() => {
    const initial = initialSnapshot();
    return initial.track?.duration ?? 0;
  });
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [queueOpen, setQueueOpen] = useState(readQueueOpen);
  const [volume, setVolumeState] = useState(() => initialSnapshot().volume);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const miniQueueWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!queueOpen) return;
    const hitTest = (cx: number, cy: number) => {
      const el = miniQueueWrapRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    return registerQueueDragHitTest(hitTest);
  }, [queueOpen]);
  const { volumeOpen, setVolumeOpen, volumePopStyle, volumeBtnRef, volumePopRef } = useMiniVolumePopover();

  const {
    isReorderDrag, psyDragFromIdxRef, dropTarget, setDropTarget, dropTargetRef, startDrag,
  } = useMiniQueueDrag({
    queueOpen,
    miniQueueWrapRef,
    queueScrollRef,
    fallbackQueueLen: state.queue.length,
  });

  // ── Context menu state ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: MiniTrackInfo; index: number } | null>(null);

  useMiniSync({
    onSync: (payload) => {
      setState(payload);
      if (payload.track?.duration) setDuration(payload.track.duration);
      if (typeof payload.volume === 'number') setVolumeState(payload.volume);
    },
    onProgress: (ct, d) => {
      setCurrentTime(ct);
      if (d > 0) setDuration(d);
    },
    onEnded: () => setCurrentTime(0),
  });
  useMiniWindowSetup(alwaysOnTop, queueOpen);
  useMiniKeyboardShortcuts();

  const control = (action: MiniControlAction) => emit('mini:control', action).catch(() => {});

  const handleVolumeChange = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    emit('mini:set-volume', { value: clamped }).catch(() => {});
  };

  const toggleMute = () => {
    handleVolumeChange(volume === 0 ? 1 : 0);
  };

  const toggleOnTop = async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    try { await invoke('set_mini_player_always_on_top', { onTop: next }); } catch {}
  };

  const closeMini = async () => {
    try { await invoke('close_mini_player'); } catch {}
  };

  const showMain = () => invoke('show_main_window').catch(() => {});

  const toggleQueue = async () => {
    const next = !queueOpen;
    // Capture the current expanded height before collapsing so the next
    // open restores it. Read window.innerHeight directly — it matches the
    // logical inner size that resize_mini_player set previously.
    if (!next) {
      const h = Math.round(window.innerHeight);
      if (h >= EXPANDED_MIN.h) {
        try { localStorage.setItem(EXPANDED_H_KEY, String(h)); } catch {}
      }
    }
    setQueueOpen(next);
    try { localStorage.setItem(QUEUE_OPEN_KEY, next ? '1' : '0'); } catch {}
    const targetH = next ? readStoredExpandedHeight() : COLLAPSED_SIZE.h;
    const targetW = next ? EXPANDED_SIZE.w : COLLAPSED_SIZE.w;
    const min = next ? EXPANDED_MIN : COLLAPSED_MIN;
    try {
      await invoke('resize_mini_player', {
        width: targetW,
        height: targetH,
        minWidth: min.w,
        minHeight: min.h,
      });
    } catch {}
  };

  const jumpTo = (index: number) => emit('mini:jump', { index }).catch(() => {});

  // Auto-scroll the current track into view when the queue expands.
  useEffect(() => {
    if (!queueOpen) return;
    const el = queueScrollRef.current?.querySelector<HTMLElement>('.mini-queue__item--current');
    el?.scrollIntoView({ block: 'nearest' });
    requestAnimationFrame(() => {
      queueScrollRef.current?.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
  }, [queueOpen, state.queueIndex]);

  const { track, isPlaying } = state;
  const miniCoverSrc = useMemo(
    () => (track?.coverArt ? buildCoverArtUrl(track.coverArt, 300) : ''),
    [track?.coverArt],
  );
  const miniCoverKey = useMemo(
    () => (track?.coverArt ? coverArtCacheKey(track.coverArt, 300) : ''),
    [track?.coverArt],
  );
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="mini-player-shell">
      <MiniTitlebar
        trackTitle={track?.title}
        alwaysOnTop={alwaysOnTop}
        toggleOnTop={toggleOnTop}
        showMain={showMain}
        closeMini={closeMini}
        t={t}
      />

      <div className={`mini-player${queueOpen ? ' mini-player--queue-open' : ''}`}>
        <MiniMeta track={track} miniCoverSrc={miniCoverSrc} miniCoverKey={miniCoverKey} />

        <MiniToolbar
          state={state}
          volume={volume}
          volumeOpen={volumeOpen}
          setVolumeOpen={setVolumeOpen}
          volumeBtnRef={volumeBtnRef}
          volumePopRef={volumePopRef}
          volumePopStyle={volumePopStyle}
          handleVolumeChange={handleVolumeChange}
          toggleMute={toggleMute}
          queueOpen={queueOpen}
          toggleQueue={toggleQueue}
          t={t}
        />

        {queueOpen && (
          <MiniQueue
            state={state}
            miniQueueWrapRef={miniQueueWrapRef}
            queueScrollRef={queueScrollRef}
            isReorderDrag={isReorderDrag}
            psyDragFromIdxRef={psyDragFromIdxRef}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            dropTargetRef={dropTargetRef}
            startDrag={startDrag}
            ctxIndex={ctxMenu?.index ?? null}
            setCtxMenu={setCtxMenu}
            jumpTo={jumpTo}
            t={t}
          />
        )}

        <MiniControls
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          progress={progress}
          control={control}
        />

        {ctxMenu && (
          <MiniContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            track={ctxMenu.track}
            index={ctxMenu.index}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </div>
    </div>
  );
}
