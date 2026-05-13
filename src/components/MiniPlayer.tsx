import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useKeybindingsStore, matchInAppBinding } from '../store/keybindingsStore';
import { registerQueueDragHitTest } from '../contexts/DragDropContext';
import { useWindowVisibility } from '../hooks/useWindowVisibility';
import { IS_LINUX } from '../utils/platform';
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

interface ProgressPayload {
  current_time: number;
  duration: number;
}

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
  const ticker = useRef<number | null>(null);
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
  const hiddenRef = useRef(false);
  const isHidden = useWindowVisibility();
  useEffect(() => { hiddenRef.current = isHidden; }, [isHidden]);

  // ── Context menu state ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: MiniTrackInfo; index: number } | null>(null);

  // Announce to main window that we're mounted; it replies with a snapshot.
  // Also re-announce on window focus: on Windows the mini is pre-created at
  // app startup so the mount-time emit can race past main's bridge before
  // it has attached its listener. Re-emitting on focus means every actual
  // open of the mini (user clicks the player-bar icon) triggers a fresh
  // sync regardless of startup ordering.
  useEffect(() => {
    emit('mini:ready', {}).catch(() => {});
    const onFocus = () => { emit('mini:ready', {}).catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Mini is a separate WebKitGTK webview: Rust applies smooth-wheel per window.
  // Re-send after auth persist hydrates so preloaded/hidden mini matches Settings.
  useEffect(() => {
    if (!IS_LINUX) return;
    const apply = () => {
      invoke('set_linux_webkit_smooth_scrolling', {
        enabled: useAuthStore.getState().linuxWebkitKineticScroll,
      }).catch(() => {});
    };
    apply();
    return useAuthStore.persist.onFinishHydration(() => {
      apply();
    });
  }, []);

  // Restore the expanded window size on initial mount when the queue was
  // open at the previous app close. Rust always builds the window at the
  // collapsed size; without this we'd render queueOpen=true into a 180 px
  // window. Brief jump from collapsed to expanded is unavoidable since
  // localStorage only lives in JS.
  useEffect(() => {
    if (!queueOpen) return;
    invoke('resize_mini_player', {
      width: EXPANDED_SIZE.w,
      height: readStoredExpandedHeight(),
      minWidth: EXPANDED_MIN.w,
      minHeight: EXPANDED_MIN.h,
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply pin state on mount and whenever the window regains focus.
  // After a Hide → Show cycle (which is what `open_mini_player` does on
  // re-toggle) the WM often drops the always-on-top constraint silently;
  // re-asserting it here means the user no longer has to click the pin
  // button twice to make it stick.
  useEffect(() => {
    invoke('set_mini_player_always_on_top', { onTop: alwaysOnTop }).catch(() => {});
    const reapply = () => {
      if (alwaysOnTop) {
        invoke('set_mini_player_always_on_top', { onTop: true }).catch(() => {});
      }
    };
    window.addEventListener('focus', reapply);
    return () => window.removeEventListener('focus', reapply);
  }, [alwaysOnTop]);

  // Keyboard: Space → toggle, ← / → → prev / next. Ignore when typing.
  // Also honour the user-configured 'open-mini-player' shortcut so the
  // same chord that opens the mini from main also closes it from here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;

      const openMiniBinding = useKeybindingsStore.getState().bindings['open-mini-player'];
      if (matchInAppBinding(e, openMiniBinding)) {
        e.preventDefault();
        emit('shortcut:run-action', {
          action: 'open-mini-player',
          source: 'mini-window',
        }).catch(() => {});
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.key?.toLowerCase() === 'z')) {
        e.preventDefault();
        if (e.shiftKey) {
          emit('mini:redo-queue', {}).catch(() => {});
        } else {
          emit('mini:undo-queue', {}).catch(() => {});
        }
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        emit('shortcut:run-action', {
          action: 'play-pause',
          source: 'mini-window',
        }).catch(() => {});
      } else if (e.key === 'ArrowRight') {
        emit('shortcut:run-action', {
          action: 'next',
          source: 'mini-window',
        }).catch(() => {});
      } else if (e.key === 'ArrowLeft') {
        emit('shortcut:run-action', {
          action: 'prev',
          source: 'mini-window',
        }).catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Subscribe to state + progress from the main window / Rust.
  useEffect(() => {
    const unSync = listen<MiniSyncPayload>('mini:sync', (e) => {
      setState(e.payload);
      if (e.payload.track?.duration) setDuration(e.payload.track.duration);
      if (typeof e.payload.volume === 'number') setVolumeState(e.payload.volume);
    });
    const unProgress = listen<ProgressPayload>('audio:progress', (e) => {
      if (hiddenRef.current || window.__psyHidden) return;
      setCurrentTime(e.payload.current_time);
      if (e.payload.duration > 0) setDuration(e.payload.duration);
    });
    const unEnded = listen('audio:ended', () => setCurrentTime(0));
    return () => {
      unSync.then(fn => fn()).catch(() => {});
      unProgress.then(fn => fn()).catch(() => {});
      unEnded.then(fn => fn()).catch(() => {});
      if (ticker.current) window.clearInterval(ticker.current);
    };
  }, []);

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
