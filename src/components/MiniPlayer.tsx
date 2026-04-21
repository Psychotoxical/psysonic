import React, { useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Play, Pause, SkipBack, SkipForward, Pin, PinOff, Maximize2, X, ListMusic, Volume2, VolumeX, Shuffle, Infinity as InfinityIcon, Waves, ArrowUpToLine } from 'lucide-react';
import CachedImage from './CachedImage';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useKeybindingsStore, matchInAppBinding } from '../store/keybindingsStore';
import { useDragDrop } from '../contexts/DragDropContext';
import { IS_LINUX } from '../utils/platform';
import MiniContextMenu from './MiniContextMenu';
import OverlayScrollArea from './OverlayScrollArea';
import type { MiniSyncPayload, MiniControlAction, MiniTrackInfo } from '../utils/miniPlayerBridge';

const COLLAPSED_SIZE = { w: 340, h: 260 };
const EXPANDED_SIZE  = { w: 340, h: 500 };
// Minimum window dimensions per state. When the queue is open the floor must
// keep at least two queue rows visible; a stricter min would let the user
// collapse the queue area to nothing while it's still toggled on.
const COLLAPSED_MIN  = { w: 320, h: 240 };
const EXPANDED_MIN   = { w: 320, h: 340 };

// Persist the expanded-window height so reopening the queue restores the
// user's preferred size instead of snapping back to EXPANDED_SIZE.h.
const EXPANDED_H_KEY = 'psysonic_mini_expanded_h';
function readStoredExpandedHeight(): number {
  try {
    const raw = localStorage.getItem(EXPANDED_H_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= EXPANDED_MIN.h) return n;
    }
  } catch {}
  return EXPANDED_SIZE.h;
}

// Persist whether the queue panel was open so the next launch restores
// the same state. Same scope as the height: localStorage of the mini
// webview (shared across mini sessions, separate from the main store).
const QUEUE_OPEN_KEY = 'psysonic_mini_queue_open';
function readQueueOpen(): boolean {
  try { return localStorage.getItem(QUEUE_OPEN_KEY) === '1'; } catch { return false; }
}

function toMini(t: any): MiniTrackInfo {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumId: t.albumId,
    artistId: t.artistId,
    coverArt: t.coverArt,
    duration: t.duration,
    starred: !!t.starred,
    year: t.year,
  };
}

/**
 * Hydrate from the persisted playerStore so initial paint shows real content
 * instead of "—" while we wait for the mini:sync event from the main window.
 * The persisted state covers the cold-start window (webview boot + bundle).
 */
function initialSnapshot(): MiniSyncPayload {
  try {
    const s = usePlayerStore.getState();
    return {
      track: s.currentTrack ? toMini(s.currentTrack) : null,
      queue: (s.queue ?? []).map(toMini),
      queueIndex: s.queueIndex ?? 0,
      isPlaying: s.isPlaying,
      volume: s.volume ?? 1,
      gaplessEnabled: false,
      crossfadeEnabled: false,
      infiniteQueueEnabled: false,
      isMobile: false,
    };
  } catch {
    return {
      track: null, queue: [], queueIndex: 0, isPlaying: false,
      volume: 1, gaplessEnabled: false, crossfadeEnabled: false,
      infiniteQueueEnabled: false, isMobile: false,
    };
  }
}

interface ProgressPayload {
  current_time: number;
  duration: number;
}

function fmt(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  const [volumeOpen, setVolumeOpen] = useState(false);
  const ticker = useRef<number | null>(null);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const volumeWrapRef = useRef<HTMLDivElement>(null);

  // ── PsyDnD reorder ──
  // Mirrors QueuePanel's pattern: mousedown threshold → startDrag, mousemove
  // on the queue computes a drop indicator, psy-drop emits mini:reorder back
  // to main where the source-of-truth store lives.
  const { isDragging: isPsyDragging, startDrag, payload: psyPayload } = useDragDrop();
  const psyDragFromIdxRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ idx: number; before: boolean } | null>(null);
  const dropTargetRef = useRef<{ idx: number; before: boolean } | null>(null);

  const isReorderDrag = isPsyDragging && !!psyPayload && (() => {
    try { return JSON.parse(psyPayload.data).type === 'queue_reorder'; } catch { return false; }
  })();

  useEffect(() => {
    if (!isPsyDragging) {
      dropTargetRef.current = null;
      setDropTarget(null);
    }
  }, [isPsyDragging]);

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
        invoke('open_mini_player').catch(() => {});
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        emit('mini:control', 'toggle').catch(() => {});
      } else if (e.key === 'ArrowRight') {
        emit('mini:control', 'next').catch(() => {});
      } else if (e.key === 'ArrowLeft') {
        emit('mini:control', 'prev').catch(() => {});
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

  // Close the volume popover on outside click / Escape.
  useEffect(() => {
    if (!volumeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (volumeWrapRef.current && !volumeWrapRef.current.contains(e.target as Node)) {
        setVolumeOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVolumeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [volumeOpen]);

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

  // Listen for psy-drop on the queue. Only handles `queue_reorder` payloads
  // since the mini player has no external drag sources. `queueOpen` must be
  // in deps because the wrap (and thus queueScrollRef.current) only mounts
  // when the queue is expanded — without it the ref is null on first run
  // and the listener never attaches.
  useEffect(() => {
    if (!queueOpen) return;
    const el = queueScrollRef.current;
    if (!el) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: any = null;
      try { parsed = JSON.parse(detail.data); } catch { return; }
      const tgt = dropTargetRef.current;
      dropTargetRef.current = null;
      setDropTarget(null);
      if (parsed.type !== 'queue_reorder') return;
      const fromIdx = parsed.index as number;
      psyDragFromIdxRef.current = null;
      const queueLen = usePlayerStore.getState().queue.length || state.queue.length;
      const insertIdx = tgt
        ? (tgt.before ? tgt.idx : tgt.idx + 1)
        : queueLen;
      if (fromIdx === insertIdx || fromIdx === insertIdx - 1) return;
      // Adjust target index if removing the source first shifts later items.
      const adjusted = fromIdx < insertIdx ? insertIdx - 1 : insertIdx;
      if (fromIdx === adjusted) return;
      emit('mini:reorder', { from: fromIdx, to: adjusted }).catch(() => {});
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [queueOpen, state.queue.length]);

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
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="mini-player-shell">
      <div
        className={`mini-player__titlebar${!IS_LINUX ? ' mini-player__titlebar--mac' : ''}`}
        {...(!IS_LINUX ? {} : { 'data-tauri-drag-region': true })}
      >
        {IS_LINUX ? (
          <span className="mini-player__titlebar-title" data-tauri-drag-region>
            {track?.title ?? 'Psysonic Mini'}
          </span>
        ) : (
          // macOS/Windows already render a native titlebar with the window
          // title + close button; we just need a flexible spacer so the
          // action buttons sit right.
          <span className="mini-player__titlebar-spacer" />
        )}
        <button
          type="button"
          className={`mini-player__titlebar-btn${alwaysOnTop ? ' mini-player__titlebar-btn--active' : ''}`}
          onClick={toggleOnTop}
          data-tauri-drag-region="false"
          data-tooltip={alwaysOnTop ? t('miniPlayer.pinOff') : t('miniPlayer.pinOnTop')}
          aria-label={alwaysOnTop ? t('miniPlayer.pinOff') : t('miniPlayer.pinOnTop')}
        >
          {alwaysOnTop ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          type="button"
          className="mini-player__titlebar-btn"
          onClick={showMain}
          data-tauri-drag-region="false"
          data-tooltip={t('miniPlayer.openMainWindow')}
          aria-label={t('miniPlayer.openMainWindow')}
        >
          <Maximize2 size={13} />
        </button>
        {/* macOS + Windows already provide Close via the native titlebar —
            skip the duplicate so the in-app titlebar stays minimal. */}
        {IS_LINUX && (
          <button
            type="button"
            className="mini-player__titlebar-btn mini-player__titlebar-btn--close"
            onClick={closeMini}
            data-tauri-drag-region="false"
            data-tooltip={t('miniPlayer.close')}
            aria-label={t('miniPlayer.close')}
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className={`mini-player${queueOpen ? ' mini-player--queue-open' : ''}`}>
        <div className="mini-player__meta">
          <div className="mini-player__art">
            {track?.coverArt ? (
              <CachedImage
                src={buildCoverArtUrl(track.coverArt, 300)}
                cacheKey={coverArtCacheKey(track.coverArt, 300)}
                alt={track.album}
              />
            ) : (
              <div className="mini-player__art-fallback" />
            )}
          </div>

          <div className="mini-player__meta-text" data-tauri-drag-region="false">
            <div className="mini-player__title" title={track?.title}>
              {track?.title ?? '—'}
            </div>
            {track?.artist && (
              <div className="mini-player__artist" title={track.artist}>{track.artist}</div>
            )}
            {track?.album && (
              <div className="mini-player__album" title={track.album}>{track.album}</div>
            )}
            {track?.year && (
              <div className="mini-player__year">{track.year}</div>
            )}
          </div>
        </div>

        <div className="mini-player__toolbar" data-tauri-drag-region="false">
          <div className="mini-player__volume-wrap" ref={volumeWrapRef}>
            <button
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
            {volumeOpen && (
              <div className="mini-player__volume-popover" data-tauri-drag-region="false">
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
              </div>
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
            <InfinityIcon size={13} />
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
            <ArrowUpToLine size={13} />
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

        {queueOpen && (
        <OverlayScrollArea
          viewportRef={queueScrollRef}
          className="mini-queue-wrap"
          viewportClassName="mini-queue"
          measureDeps={[queueOpen, state.queue.length]}
          railInset="mini"
          viewportScrollBehaviorAuto={isReorderDrag}
          onMouseMove={(e) => {
            if (!isReorderDrag || !queueScrollRef.current) return;
            const items = queueScrollRef.current.querySelectorAll<HTMLElement>('[data-mq-idx]');
            for (let i = 0; i < items.length; i++) {
              const r = items[i].getBoundingClientRect();
              if (e.clientY >= r.top && e.clientY <= r.bottom) {
                const before = e.clientY < r.top + r.height / 2;
                const idx = parseInt(items[i].dataset.mqIdx!, 10);
                const t = { idx, before };
                dropTargetRef.current = t;
                setDropTarget(t);
                return;
              }
            }
            dropTargetRef.current = null;
            setDropTarget(null);
          }}
        >
            {state.queue.length === 0 ? (
              <div className="mini-queue__empty">{t('miniPlayer.emptyQueue')}</div>
            ) : (
              state.queue.map((t, i) => {
                let dragStyle: React.CSSProperties = {};
                if (isReorderDrag && psyDragFromIdxRef.current === i) {
                  dragStyle = { opacity: 0.4 };
                } else if (isReorderDrag && dropTarget?.idx === i) {
                  dragStyle = dropTarget.before
                    ? { boxShadow: 'inset 0 2px 0 var(--accent)' }
                    : { boxShadow: 'inset 0 -2px 0 var(--accent)' };
                }
                return (
                  <button
                    key={`${t.id}-${i}`}
                    data-mq-idx={i}
                    className={`mini-queue__item${i === state.queueIndex ? ' mini-queue__item--current' : ''}${ctxMenu?.index === i ? ' mini-queue__item--ctx' : ''}`}
                    onClick={() => jumpTo(i)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, track: t, index: i });
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      // Don't start drag while a click would also be valid —
                      // the threshold check below upgrades to a drag once
                      // the pointer leaves the deadband.
                      const startX = e.clientX;
                      const startY = e.clientY;
                      const onMove = (me: MouseEvent) => {
                        if (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5) {
                          document.removeEventListener('mousemove', onMove);
                          document.removeEventListener('mouseup', onUp);
                          psyDragFromIdxRef.current = i;
                          startDrag(
                            { data: JSON.stringify({ type: 'queue_reorder', index: i }), label: t.title },
                            me.clientX,
                            me.clientY,
                          );
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
                    <span className="mini-queue__num">{i + 1}</span>
                    <div className="mini-queue__meta">
                      <div className="mini-queue__title">{t.title}</div>
                      <div className="mini-queue__artist">{t.artist}</div>
                    </div>
                  </button>
                );
              })
            )}
        </OverlayScrollArea>
      )}

        <div className="mini-player__bottom" data-tauri-drag-region="false">
          <div className="mini-player__controls">
            <button className="mini-player__btn" onClick={() => control('prev')} data-tauri-drag-region="false">
              <SkipBack size={16} />
            </button>
            <button className="mini-player__btn mini-player__btn--primary" onClick={() => control('toggle')} data-tauri-drag-region="false">
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button className="mini-player__btn" onClick={() => control('next')} data-tauri-drag-region="false">
              <SkipForward size={16} />
            </button>
          </div>

          <div className="mini-player__progress">
            <div className="mini-player__progress-time">{fmt(currentTime)}</div>
            <div className="mini-player__progress-track">
              <div className="mini-player__progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="mini-player__progress-time">{fmt(duration)}</div>
          </div>
        </div>

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
