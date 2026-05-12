import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicPlaylist } from '../api/subsonicTypes';
import { registerQueueListScrollTopReader, consumePendingQueueListScrollTop } from '../store/queueUndo';
import { songToTrack } from '../utils/songToTrack';
import type { Track } from '../store/playerStoreTypes';
import React, { useState, useRef, useMemo, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/playerStore';
import { useOrbitStore } from '../store/orbitStore';
import OrbitGuestQueue from './OrbitGuestQueue';
import OrbitQueueHead from './OrbitQueueHead';
import HostApprovalQueue from './HostApprovalQueue';
import { Play, Music, Star, X, Trash2, Save, FolderOpen, Shuffle, Infinity, Waves, MicVocal, ListMusic, Check, ListPlus, MoveRight, Radio, HardDrive, ChevronDown, Info, Share2 } from 'lucide-react';
import { getPlaylists, getPlaylist, updatePlaylist, deletePlaylist } from '../api/subsonic';
import { usePlaylistStore } from '../store/playlistStore';
import { useCachedUrl } from './CachedImage';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { encodeSharePayload } from '../utils/shareLink';
import { copyTextToClipboard } from '../utils/serverMagicString';
import { showToast } from '../utils/toast';
import { useThemeStore } from '../store/themeStore';
import { useLyricsStore } from '../store/lyricsStore';
import { useDragDrop, registerQueueDragHitTest } from '../contexts/DragDropContext';
import LyricsPane from './LyricsPane';
import NowPlayingInfo from './NowPlayingInfo';
import { TFunction } from 'i18next';
import OverlayScrollArea from './OverlayScrollArea';
import { useLuckyMixStore } from '../store/luckyMixStore';
import { useQueueToolbarStore, QueueToolbarButtonId } from '../store/queueToolbarStore';
import { loudnessGainPlaceholderUntilCacheDb } from '../utils/loudnessPlaceholder';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../utils/loudnessPreAnalysisSlider';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatQueueReplayGainParts(track: Track, t: TFunction): string[] {
  const parts: string[] = [];
  const fmtDb = (db: number) => `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
  if (track.replayGainTrackDb != null) {
    parts.push(t('queue.rgTrack', { db: fmtDb(track.replayGainTrackDb) }));
  }
  if (track.replayGainAlbumDb != null) {
    parts.push(t('queue.rgAlbum', { db: fmtDb(track.replayGainAlbumDb) }));
  }
  if (track.replayGainPeak != null) {
    parts.push(t('queue.rgPeak', { pk: track.replayGainPeak.toFixed(3) }));
  }
  return parts;
}

function renderStars(rating?: number) {
  if (!rating) return null;
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(
      <Star 
        key={i} 
        size={12} 
        fill={i <= rating ? 'var(--ctp-yellow)' : 'none'} 
        color={i <= rating ? 'var(--ctp-yellow)' : 'var(--text-muted)'} 
      />
    );
  }
  return <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>{stars}</div>;
}

function SavePlaylistModal({ onClose, onSave }: { onClose: () => void, onSave: (name: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <h3 style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)' }}>{t('queue.savePlaylist')}</h3>
        <input 
          type="text" 
          className="live-search-field" 
          placeholder={t('queue.playlistName')} 
          value={name} 
          onChange={e => setName(e.target.value)}
          autoFocus
          onKeyDown={e => e.key === 'Enter' && name.trim() && onSave(name.trim())}
          style={{ width: '100%', marginBottom: '1rem', padding: '10px 16px' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-ghost" onClick={onClose}>{t('queue.cancel')}</button>
          <button className="btn btn-primary" onClick={() => name.trim() && onSave(name.trim())}>{t('queue.save')}</button>
        </div>
      </div>
    </div>
  );
}

function LoadPlaylistModal({ onClose, onLoad }: { onClose: () => void, onLoad: (id: string, name: string, mode: 'replace' | 'append') => void }) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<SubsonicPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const fetchPlaylists = () => {
    setLoading(true);
    getPlaylists().then(data => {
      setPlaylists(data);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  };

  useEffect(() => {
    fetchPlaylists();
  }, []);

  const handleDelete = async (id: string, name: string) => {
    setConfirmDelete({ id, name });
  };

  const confirmDeletePlaylist = async () => {
    if (!confirmDelete) return;
    await deletePlaylist(confirmDelete.id);
    setConfirmDelete(null);
    fetchPlaylists();
  };

  return (
    <>
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '560px', width: '90vw' }}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <h3 style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)' }}>{t('queue.loadPlaylist')}</h3>
        {!loading && playlists.length > 0 && (
          <input
            type="text"
            className="live-search-field"
            placeholder={t('queue.filterPlaylists')}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            autoFocus
            style={{ width: '100%', marginBottom: '0.75rem', padding: '8px 14px' }}
          />
        )}
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.loading')}</p>
        ) : playlists.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.noPlaylists')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
            {playlists.filter(p => p.name.toLowerCase().includes(filter.toLowerCase())).map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--ctp-surface1)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontWeight: 500 }} className="truncate" data-tooltip={p.name}>{p.name}</span>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button className="nav-btn" onClick={() => onLoad(p.id, p.name, 'replace')} data-tooltip={t('queue.load')} style={{ width: '28px', height: '28px', background: 'transparent' }}><Play size={14} /></button>
                  <button className="nav-btn" onClick={() => onLoad(p.id, p.name, 'append')} data-tooltip={t('queue.appendToQueue')} style={{ width: '28px', height: '28px', background: 'transparent' }}><ListPlus size={14} /></button>
                  <button className="nav-btn" onClick={() => handleDelete(p.id, p.name)} data-tooltip={t('queue.delete')} style={{ width: '28px', height: '28px', background: 'transparent', color: 'var(--ctp-red)' }}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>

    {confirmDelete && (
      <div className="modal-overlay" onClick={() => setConfirmDelete(null)} role="dialog" aria-modal="true">
        <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '360px' }}>
          <button className="modal-close" onClick={() => setConfirmDelete(null)}><X size={18} /></button>
          <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>{t('queue.delete')}</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
            {t('queue.deleteConfirm', { name: confirmDelete.name })}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>{t('queue.cancel')}</button>
            <button className="btn btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={confirmDeletePlaylist}>
              {t('queue.delete')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

type DurationMode = 'total' | 'remaining' | 'eta';

interface QueueHeaderProps {
  queue: Track[];
  queueIndex: number;
  activePlaylist: { id: string; name: string } | null;
  isNowPlayingCollapsed: boolean;
  setIsNowPlayingCollapsed: (v: boolean) => void;
  durationMode: DurationMode;
  setDurationMode: (m: DurationMode) => void;
  t: TFunction;
}
function QueueHeader({ queue, queueIndex, activePlaylist, isNowPlayingCollapsed, setIsNowPlayingCollapsed, durationMode, setDurationMode, t }: QueueHeaderProps) {
  const currentTime = usePlayerStore((s) => Math.floor(s.currentTime / 30) * 30);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const totalSecs = useMemo(() =>
    queue.reduce((acc: number, track: Track) => acc + (track.duration || 0), 0),
    [queue]
  );
  const futureTracksDuration = useMemo(() =>
    queue.slice(queueIndex + 1).reduce((acc: number, track: Track) => acc + (track.duration || 0), 0),
    [queue, queueIndex]
  );

  const remainingSecs = Math.max(0, (queue[queueIndex]?.duration ?? 0) - currentTime + futureTracksDuration);

  const fmt = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}` : `${m}:${s.toString().padStart(2, "0")}`;
  };
  const fmtEta = (secs: number) => {
    const finishTime = new Date(Date.now() + secs * 1000);
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(finishTime);
  };

  let dur: string | null = null;
  if (queue.length > 0) {
    if (durationMode === 'total') dur = fmt(Math.floor(totalSecs));
    else if (durationMode === 'remaining') dur = `-${fmt(Math.floor(remainingSecs))}`;
    else dur = fmtEta(remainingSecs);
  }

  const nextMode: DurationMode =
    durationMode === 'total' ? 'remaining' :
    durationMode === 'remaining' ? 'eta' : 'total';
  const nextTooltipKey =
    nextMode === 'total' ? 'queue.showTotal' :
    nextMode === 'remaining' ? 'queue.showRemaining' : 'queue.showEta';

  const isEta = durationMode === 'eta';

  return (
    <div className="queue-header">
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 }}>
          <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0, flexShrink: 0 }}>{t("queue.title")}</h2>
          {queue.length > 0 && (
            <span style={{ fontSize: "13px", color: "var(--text-muted)", whiteSpace: "nowrap", userSelect: "none" }}>
              ({queueIndex + 1}/{queue.length})
            </span>
          )}
          {dur !== null && (
            <span
              onClick={() => setDurationMode(nextMode)}
              data-tooltip={t(nextTooltipKey)}
              style={{
                fontSize: "13px",
                color: isEta ? (isPlaying ? "var(--accent)" : "var(--text-muted)") : "var(--accent)",
                opacity: isEta && !isPlaying ? 0.5 : 1,
                whiteSpace: "nowrap",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              · {dur}
            </span>
          )}
        </div>
        {activePlaylist && (
          <div className="truncate" style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px", display: "flex", alignItems: "center", gap: "4px" }}>
            <ListMusic size={10} style={{ flexShrink: 0 }} />
            <span className="truncate">{activePlaylist.name}</span>
          </div>
        )}
      </div>
      <button
        className="queue-action-btn"
        onClick={() => queue.length > 0 && setIsNowPlayingCollapsed(!isNowPlayingCollapsed)}
        disabled={queue.length === 0}
        data-tooltip={queue.length === 0 ? t('queue.emptyQueue') : (isNowPlayingCollapsed ? t('queue.showNowPlaying') : t('queue.hideNowPlaying'))}
        aria-label={queue.length === 0 ? t('queue.emptyQueue') : (isNowPlayingCollapsed ? t('queue.showNowPlaying') : t('queue.hideNowPlaying'))}
        aria-expanded={!isNowPlayingCollapsed}
        style={{ marginLeft: '8px', opacity: queue.length === 0 ? 0.3 : 1, cursor: queue.length === 0 ? 'not-allowed' : 'pointer' }}
      >
        <ChevronDown size={18} style={{ transform: isNowPlayingCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.2s ease' }} />
      </button>
    </div>
  );
}

export default function QueuePanel() {
  const orbitRole = useOrbitStore(s => s.role);
  if (orbitRole === 'guest') {
    return (
      <aside className="queue-panel queue-panel--orbit-guest">
        <OrbitGuestQueue />
      </aside>
    );
  }
  return <QueuePanelHostOrSolo />;
}

function QueuePanelHostOrSolo() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const orbitRole = useOrbitStore(s => s.role);
  const orbitState = useOrbitStore(s => s.state);
  /** trackId → addedBy (host username or guest username) — only populated while
   *  hosting an Orbit session, so the queue rows can surface attribution. */
  const orbitAddedByByTrack = useMemo(() => {
    const map = new Map<string, string>();
    if (orbitRole !== 'host' || !orbitState) return map;
    if (orbitState.currentTrack) {
      map.set(orbitState.currentTrack.trackId, orbitState.currentTrack.addedBy);
    }
    for (const q of orbitState.queue) map.set(q.trackId, q.addedBy);
    return map;
  }, [orbitRole, orbitState]);
  const orbitHostUsername = orbitState?.host ?? '';
  /** Attribution label for a queue row / current track while hosting. Null when
   *  not in a hosted session. Bulk-adds (album / playlist enqueue) bypass
   *  `hostEnqueueToOrbit` and therefore never land in `state.queue`, so we
   *  default those to "Added by you" rather than showing nothing. */
  const orbitAttributionLabel = (trackId: string): string | null => {
    if (orbitRole !== 'host' || !orbitState) return null;
    const addedBy = orbitAddedByByTrack.get(trackId);
    if (!addedBy || addedBy === orbitHostUsername) return t('orbit.queueAddedByYou');
    return t('orbit.queueAddedByUser', { user: addedBy });
  };
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const currentCoverFetchUrl = useMemo(
    () => currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 128) : '',
    [currentTrack?.coverArt]
  );
  const currentCoverCacheKey = useMemo(
    () => currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 128) : '',
    [currentTrack?.coverArt]
  );
  const currentCoverSrc = useCachedUrl(currentCoverFetchUrl, currentCoverCacheKey);
  const isQueueVisible = usePlayerStore(s => s.isQueueVisible);
  const playTrack = usePlayerStore(s => s.playTrack);
  const toggleQueue = usePlayerStore(s => s.toggleQueue);
  const clearQueue = usePlayerStore(s => s.clearQueue);

  const reorderQueue = usePlayerStore(s => s.reorderQueue);
  const removeTrack = usePlayerStore(s => s.removeTrack);
  const shuffleQueue = usePlayerStore(s => s.shuffleQueue);
  const enqueue = usePlayerStore(s => s.enqueue);
  const enqueueAt = usePlayerStore(s => s.enqueueAt);
  const contextMenu = usePlayerStore(s => s.contextMenu);

  // When the user picks a track *from* the queue list, suppress the
  // upcoming auto-scroll so their click target stays in view instead of
  // the list rebasing onto the next track. Auto-advance (natural playback)
  // never sets this flag, so it keeps its original "show what's next" behavior.
  const suppressNextAutoScrollRef = useRef(false);

  const playbackSource = usePlayerStore(s => s.currentPlaybackSource);
  const normalizationNowDb = usePlayerStore(s => s.normalizationNowDb);
  const normalizationTargetLufs = usePlayerStore(s => s.normalizationTargetLufs);
  const normalizationEngineLive = usePlayerStore(s => s.normalizationEngineLive);

  const crossfadeEnabled = useAuthStore(s => s.crossfadeEnabled);
  const crossfadeSecs = useAuthStore(s => s.crossfadeSecs);
  const gaplessEnabled = useAuthStore(s => s.gaplessEnabled);
  const infiniteQueueEnabled = useAuthStore(s => s.infiniteQueueEnabled);
  const setCrossfadeEnabled = useAuthStore(s => s.setCrossfadeEnabled);
  const setCrossfadeSecs = useAuthStore(s => s.setCrossfadeSecs);
  const setGaplessEnabled = useAuthStore(s => s.setGaplessEnabled);
  const setInfiniteQueueEnabled = useAuthStore(s => s.setInfiniteQueueEnabled);
  const normalizationEngine = useAuthStore(s => s.normalizationEngine);
  const replayGainMode = useAuthStore(s => s.replayGainMode);

  const activeTab  = useLyricsStore(s => s.activeTab);
  const setTab     = useLyricsStore(s => s.setTab);
  const luckyRolling = useLuckyMixStore(s => s.isRolling);

  const isNowPlayingCollapsed = useAuthStore(s => s.queueNowPlayingCollapsed);
  const setIsNowPlayingCollapsed = useAuthStore(s => s.setQueueNowPlayingCollapsed);
  const toolbarButtons = useQueueToolbarStore(s => s.buttons);
  const [durationMode, setDurationMode] = useState<DurationMode>('total');
  const [showCrossfadePopover, setShowCrossfadePopover] = useState(false);
  const [lufsTgtOpen, setLufsTgtOpen] = useState(false);
  const [lufsTgtPopStyle, setLufsTgtPopStyle] = useState<React.CSSProperties>({});
  const lufsTgtBtnRef = useRef<HTMLButtonElement>(null);
  const lufsTgtMenuRef = useRef<HTMLDivElement>(null);
  const expandReplayGain = useThemeStore(s => s.expandReplayGain);
  const setExpandReplayGain = useThemeStore(s => s.setExpandReplayGain);
  const crossfadeBtnRef = useRef<HTMLButtonElement>(null);
  const crossfadePopoverRef = useRef<HTMLDivElement>(null);
  const reanalyzeLoudnessForTrack = usePlayerStore(s => s.reanalyzeLoudnessForTrack);
  const authLoudnessTargetLufs = useAuthStore(s => s.loudnessTargetLufs);
  const setLoudnessTargetLufs = useAuthStore(s => s.setLoudnessTargetLufs);
  const loudnessPreAnalysisAttenuationDb = useAuthStore(s => s.loudnessPreAnalysisAttenuationDb);

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

  useEffect(() => {
    if (!lufsTgtOpen) return;
    const handle = (e: MouseEvent) => {
      if (
        lufsTgtBtnRef.current?.contains(e.target as Node) ||
        lufsTgtMenuRef.current?.contains(e.target as Node)
      ) return;
      setLufsTgtOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [lufsTgtOpen]);

  const updateLufsTgtPopStyle = () => {
    if (!lufsTgtBtnRef.current) return;
    const rect = lufsTgtBtnRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const WIDTH = 160;
    const MAX_H = 220;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < 120 && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(rect.right - WIDTH, 8),
      window.innerWidth - WIDTH - 8,
    );
    setLufsTgtPopStyle({
      position: 'fixed',
      left,
      width: WIDTH,
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + MARGIN }
        : { top: rect.bottom + MARGIN }),
      maxHeight: Math.min(MAX_H, useAbove ? spaceAbove : spaceBelow),
      zIndex: 99998,
    });
  };

  useLayoutEffect(() => {
    if (!lufsTgtOpen) return;
    updateLufsTgtPopStyle();
  }, [lufsTgtOpen]);

  useEffect(() => {
    if (!lufsTgtOpen) return;
    const onResize = () => updateLufsTgtPopStyle();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [lufsTgtOpen]);

  useEffect(() => {
    if (!expandReplayGain) setLufsTgtOpen(false);
  }, [expandReplayGain]);

  // Tracks which queue index is being psy-dragged for opacity visual feedback
  const psyDragFromIdxRef = useRef<number | null>(null);

  const queueListRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    registerQueueListScrollTopReader(() => queueListRef.current?.scrollTop);
    return () => registerQueueListScrollTopReader(null);
  }, []);

  useLayoutEffect(() => {
    const top = consumePendingQueueListScrollTop();
    if (top === undefined) return;
    const el = queueListRef.current;
    if (!el) return;
    suppressNextAutoScrollRef.current = true;
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll', { bubbles: false }));
  }, [queue, queueIndex, currentTrack?.id]);

  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const hitTest = (cx: number, cy: number) => {
      const el = asideRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    return registerQueueDragHitTest(hitTest);
  }, []);

  const { isDragging: isPsyDragging, startDrag, payload: psyPayload } = useDragDrop();
  /** Only these drag types may be dropped into the queue. */
  const QUEUE_DROP_TYPES = new Set(['song', 'album', 'queue_reorder']);
  const isQueueDrag = isPsyDragging && !!psyPayload && (() => {
    try { return QUEUE_DROP_TYPES.has(JSON.parse(psyPayload.data).type); } catch { return false; }
  })();
  // Keep for the onPsyDrop radio-reject check below
  const isRadioDrag = isPsyDragging && !!psyPayload && (() => {
    try { return JSON.parse(psyPayload.data).type === 'radio'; } catch { return false; }
  })();

  useEffect(() => {
    if (!isPsyDragging) {
      externalDropTargetRef.current = null;
      setExternalDropTarget(null);
    }
  }, [isPsyDragging]);

  const [externalDropTarget, setExternalDropTarget] = useState<{ idx: number; before: boolean } | null>(null);
  const externalDropTargetRef = useRef<{ idx: number; before: boolean } | null>(null);

  // ── Mouse-event DnD: listen for psy-drop custom events ─────────
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;

    const onPsyDrop = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;

      let parsedData: any = null;
      try { parsedData = JSON.parse(detail.data); } catch { return; }

      // Radio streams are not tracks — reject silently
      if (parsedData.type === 'radio') return;

      const dropTarget = externalDropTargetRef.current;
      externalDropTargetRef.current = null;
      setExternalDropTarget(null);

      const insertIdx = dropTarget
        ? (dropTarget.before ? dropTarget.idx : dropTarget.idx + 1)
        : usePlayerStore.getState().queue.length;

      if (parsedData.type === 'queue_reorder') {
        const fromIdx: number = parsedData.index;
        psyDragFromIdxRef.current = null;
        if (fromIdx !== insertIdx) reorderQueue(fromIdx, insertIdx);
      } else if (parsedData.type === 'song') {
        enqueueAt([parsedData.track], insertIdx);
      } else if (parsedData.type === 'songs') {
        enqueueAt(parsedData.tracks as Track[], insertIdx);
      } else if (parsedData.type === 'album') {
        const albumData = await getAlbum(parsedData.id);
        const tracks: Track[] = albumData.songs.map((s: any) => ({
          id: s.id, title: s.title, artist: s.artist, album: s.album,
          albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
          year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating, genre: s.genre,
        }));
        enqueueAt(tracks, insertIdx);
      }
    };

    aside.addEventListener('psy-drop', onPsyDrop);
    return () => aside.removeEventListener('psy-drop', onPsyDrop);
  }, [enqueueAt]);

  // Drag a queue row outside the panel → remove (drop never reaches `aside`).
  useEffect(() => {
    const onDocPsyDrop = (e: Event) => {
      if (!isQueueVisible) return;
      const d = (e as CustomEvent<{ data?: string; clientX?: number; clientY?: number }>).detail;
      if (!d?.data) return;
      const cx = d.clientX;
      const cy = d.clientY;
      if (typeof cx !== 'number' || typeof cy !== 'number') return;
      let parsed: { type?: string; index?: number } | null = null;
      try {
        parsed = JSON.parse(d.data);
      } catch {
        return;
      }
      if (parsed?.type !== 'queue_reorder' || typeof parsed.index !== 'number') return;
      const aside = asideRef.current;
      if (!aside) return;
      const r = aside.getBoundingClientRect();
      const inside =
        cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      if (inside) return;
      psyDragFromIdxRef.current = null;
      externalDropTargetRef.current = null;
      setExternalDropTarget(null);
      removeTrack(parsed.index);
    };
    document.addEventListener('psy-drop', onDocPsyDrop);
    return () => document.removeEventListener('psy-drop', onDocPsyDrop);
  }, [isQueueVisible, removeTrack]);

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
    nextSong.scrollIntoView({ block: "start", behavior: "instant" });
    requestAnimationFrame(() => {
      queueListRef.current?.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
  }, [currentTrack, activeTab]);

  const [activePlaylist, setActivePlaylist] = useState<{ id: string; name: string } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [loadModalOpen, setLoadModalOpen] = useState(false);

  const handleSave = async () => {
    if (queue.length === 0) return;
    if (activePlaylist) {
      setSaveState('saving');
      try {
        await updatePlaylist(activePlaylist.id, queue.map(t => t.id));
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 1500);
      } catch (e) {
        console.error('Failed to update playlist', e);
        setSaveState('idle');
      }
    } else {
      setSaveModalOpen(true);
    }
  };

  const handleLoad = () => {
    setLoadModalOpen(true);
  };

  const handleClear = () => {
    clearQueue();
    setActivePlaylist(null);
  };

  const handleCopyQueueShare = async () => {
    if (queue.length === 0) {
      showToast(t('queue.shareQueueEmpty'), 3000, 'info');
      return;
    }
    const srv = useAuthStore.getState().getBaseUrl();
    if (!srv) return;
    const ids = queue.map(t => t.id);
    const ok = await copyTextToClipboard(encodeSharePayload({ srv, k: 'queue', ids }));
    if (ok) showToast(t('contextMenu.shareCopied'));
    else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
  };

  return (
    <aside
      ref={asideRef}
      className={`queue-panel${isQueueDrag ? ' queue-drop-active' : ''}`}
      onMouseMove={e => {
        if (!isQueueDrag || !queueListRef.current) return;
        const items = queueListRef.current.querySelectorAll<HTMLElement>('[data-queue-idx]');
        let found = false;
        for (let i = 0; i < items.length; i++) {
          const rect = items[i].getBoundingClientRect();
          if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            const before = e.clientY < rect.top + rect.height / 2;
            const idx = parseInt(items[i].dataset.queueIdx!);
            const target = { idx, before };
            externalDropTargetRef.current = target;
            setExternalDropTarget(target);
            found = true;
            break;
          }
        }
        if (!found) {
          externalDropTargetRef.current = null;
          setExternalDropTarget(null);
        }
      }}
      style={{
        borderLeftWidth: isQueueVisible ? 1 : 0,
      }}
    >
      {orbitRole === 'host' && orbitState && (
        <>
          <OrbitQueueHead state={orbitState} />
          <HostApprovalQueue />
        </>
      )}
      <QueueHeader
        queue={queue}
        queueIndex={queueIndex}
        activePlaylist={activePlaylist}
        isNowPlayingCollapsed={isNowPlayingCollapsed}
        setIsNowPlayingCollapsed={setIsNowPlayingCollapsed}
        durationMode={durationMode}
        setDurationMode={setDurationMode}
        t={t}
      />

      {currentTrack && !isNowPlayingCollapsed && (
        <div className="queue-current-track">
          {(() => {
            const baseParts = [
              currentTrack.suffix?.toUpperCase(),
              currentTrack.bitRate ? `${currentTrack.bitRate} kbps` : undefined,
              (() => {
                const bd = currentTrack.bitDepth;
                const sr = currentTrack.samplingRate ? `${currentTrack.samplingRate / 1000} kHz` : '';
                if (bd && sr) return `${bd}/${sr}`;
                if (bd) return `${bd}-bit`;
                if (sr) return sr;
                return undefined;
              })(),
            ].filter(Boolean) as string[];
            const rgParts = formatQueueReplayGainParts(currentTrack, t);
            const baseLine = baseParts.join(' · ');
            const rgLine = rgParts.join(' · ');
            const isLoudnessActive = normalizationEngine === 'loudness' || normalizationEngineLive === 'loudness';
            const liveGainLabel = (() => {
              if (normalizationNowDb != null && Number.isFinite(normalizationNowDb)) {
                return `${normalizationNowDb >= 0 ? '+' : ''}${normalizationNowDb.toFixed(2)} dB`;
              }
              if (isLoudnessActive && Number.isFinite(loudnessPreAnalysisAttenuationDb)) {
                const preEff = effectiveLoudnessPreAnalysisAttenuationDb(
                  loudnessPreAnalysisAttenuationDb,
                  authLoudnessTargetLufs,
                );
                const ph = loudnessGainPlaceholderUntilCacheDb(
                  authLoudnessTargetLufs,
                  preEff,
                );
                return `${ph >= 0 ? '+' : ''}${ph.toFixed(2)} dB`;
              }
              return '—';
            })();
            const tgtNum = normalizationTargetLufs ?? authLoudnessTargetLufs;
            const targetLabel = `${tgtNum} LUFS`;
            if (!baseLine && !rgLine && !playbackSource) return null;
            const showRgLine = !isLoudnessActive && expandReplayGain && !!rgLine;
            const showLufsLine = isLoudnessActive && expandReplayGain;
            return (
              <div className={`queue-current-tech${showRgLine ? ' queue-current-tech--two-line' : ''}`}>
                <div className="queue-current-tech-stack">
                  <div className="queue-current-tech-row">
                    {playbackSource && (
                      <span
                        className="queue-current-tech-source"
                        data-tooltip={
                          playbackSource === 'offline'
                            ? t('queue.sourceOffline')
                            : playbackSource === 'hot'
                              ? t('queue.sourceHot')
                              : t('queue.sourceStream')
                        }
                        aria-hidden
                      >
                        {playbackSource === 'offline' && <FolderOpen size={11} strokeWidth={2.25} />}
                        {playbackSource === 'hot' && <HardDrive size={11} strokeWidth={2.25} />}
                        {playbackSource === 'stream' && <Waves size={11} strokeWidth={2.25} />}
                      </span>
                    )}
                    {baseLine && <span className="queue-current-tech-main">{baseLine}</span>}
                    {!isLoudnessActive && rgLine && (
                      <button
                        type="button"
                        className={`queue-current-tech-rg-badge${showRgLine ? ' queue-current-tech-rg-badge--open' : ''}`}
                        data-tooltip={`${t('queue.replayGain')} · ${rgLine}`}
                        aria-expanded={showRgLine}
                        aria-label={t('queue.replayGain')}
                        onClick={() => setExpandReplayGain(!expandReplayGain)}
                      >
                        RG
                        <ChevronDown size={9} strokeWidth={2.5} />
                      </button>
                    )}
                    {isLoudnessActive && (
                      <button
                        type="button"
                        className={`queue-current-tech-rg-badge${showLufsLine ? ' queue-current-tech-rg-badge--open' : ''}`}
                        data-tooltip={`LUFS · ${liveGainLabel} · TGT · ${targetLabel}`}
                        aria-expanded={showLufsLine}
                        aria-label="LUFS"
                        onClick={() => setExpandReplayGain(!expandReplayGain)}
                      >
                        LUFS
                        <ChevronDown size={9} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                  {showRgLine && (
                    <span className="queue-current-tech-rg">
                      <span className="queue-current-tech-rg-label">{t('queue.replayGain')}</span>
                      {' · '}{rgLine}
                    </span>
                  )}
                  {showLufsLine && (
                    <span className="queue-current-tech-rg">
                      <span className="queue-current-tech-rg-label">Loudness</span>
                      {' · '}
                      <button
                        type="button"
                        className="queue-current-tech-metric queue-current-tech-metric--lufs-reanalyze"
                        onClick={e => {
                          e.stopPropagation();
                          setLufsTgtOpen(false);
                          void reanalyzeLoudnessForTrack(currentTrack.id);
                        }}
                        data-tooltip={t('queue.clearCachedLoudnessWaveform')}
                        aria-label={t('queue.clearCachedLoudnessWaveform')}
                      >
                        {liveGainLabel}
                      </button>
                      {' · '}
                      <span className="queue-current-tech-rg-label">TGT</span>
                      {' · '}
                      <button
                        type="button"
                        ref={lufsTgtBtnRef}
                        className="queue-current-tech-metric"
                        onClick={e => {
                          e.stopPropagation();
                          setLufsTgtOpen(v => !v);
                        }}
                        data-tooltip="Change target integrated loudness"
                        aria-haspopup="listbox"
                        aria-expanded={lufsTgtOpen}
                      >
                        {targetLabel}
                      </button>
                      {lufsTgtOpen &&
                        createPortal(
                          <div
                            ref={lufsTgtMenuRef}
                            className="queue-lufs-tgt-menu"
                            style={{
                              ...lufsTgtPopStyle,
                              background: 'var(--bg-card)',
                              border: '1px solid var(--border, rgba(255,255,255,0.12))',
                              borderRadius: 8,
                              boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
                              padding: 6,
                              overflow: 'auto',
                            }}
                            role="listbox"
                            aria-label="LUFS target"
                            onClick={e => e.stopPropagation()}
                          >
                            {([-10, -12, -14, -16] as const).map((v) => (
                              <button
                                key={v}
                                type="button"
                                onClick={e => {
                                  e.stopPropagation();
                                  if (v !== authLoudnessTargetLufs) {
                                    setLoudnessTargetLufs(v);
                                  }
                                  setLufsTgtOpen(false);
                                }}
                                style={{
                                  display: 'block',
                                  width: '100%',
                                  textAlign: 'left',
                                  padding: '6px 8px',
                                  borderRadius: 6,
                                  border: 'none',
                                  background: v === authLoudnessTargetLufs ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                                  color: 'var(--text-primary)',
                                  cursor: 'pointer',
                                  font: 'inherit',
                                }}
                              >
                                {v} LUFS
                              </button>
                            ))}
                          </div>,
                          document.body,
                        )}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
          <div className="queue-current-track-body">
            <div className="queue-current-cover">
              {currentTrack.coverArt ? (
                <img src={currentCoverSrc} alt="" loading="eager" />
              ) : (
                <div className="fallback"><Music size={32} /></div>
              )}
            </div>
            <div className="queue-current-info">
              <h3 className="truncate">{currentTrack.title}</h3>
              <div
                className={`queue-current-sub truncate${currentTrack.artistId ? ' is-link' : ''}`}
                onClick={() => currentTrack.artistId && navigate(`/artist/${currentTrack.artistId}`)}
              >{currentTrack.artist}</div>
              <div
                className={`queue-current-sub truncate${currentTrack.albumId ? ' is-link' : ''}`}
                onClick={() => currentTrack.albumId && navigate(`/album/${currentTrack.albumId}`)}
              >{currentTrack.album}</div>
              {currentTrack.year && (
                <div className="queue-current-sub">{currentTrack.year}</div>
              )}
              {(() => {
                const label = orbitAttributionLabel(currentTrack.id);
                return label ? <div className="queue-current-sub queue-current-attribution">{label}</div> : null;
              })()}
              {renderStars(userRatingOverrides[currentTrack.id] ?? currentTrack.userRating)}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'queue' ? (<>
        {!isNowPlayingCollapsed && toolbarButtons.some(b => b.visible && b.id !== 'separator') && (
          <div className="queue-toolbar">
            {toolbarButtons.map((btn, idx) => {
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
        )}

      {currentTrack && queue.length > 0 && <div className="queue-divider"><span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>{t('queue.nextTracks')}</span></div>}

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
      </>) : activeTab === 'lyrics' ? (
        <LyricsPane currentTrack={currentTrack} />
      ) : (
        <NowPlayingInfo />
      )}

      <div className="queue-tab-bar">
        <button
          className={`queue-tab-btn${activeTab === 'queue' ? ' active' : ''}`}
          onClick={() => setTab('queue')}
          aria-label={t('queue.title')}
        >
          <ListMusic size={14} />
          {t('queue.title')}
        </button>
        <button
          className={`queue-tab-btn${activeTab === 'lyrics' ? ' active' : ''}`}
          onClick={() => setTab('lyrics')}
          aria-label={t('player.lyrics')}
        >
          <MicVocal size={14} />
          {t('player.lyrics')}
        </button>
        <button
          className={`queue-tab-btn${activeTab === 'info' ? ' active' : ''}`}
          onClick={() => setTab('info')}
          aria-label={t('nowPlayingInfo.tab')}
        >
          <Info size={14} />
          {t('nowPlayingInfo.tab')}
        </button>
      </div>

      {saveModalOpen && (
        <SavePlaylistModal
          onClose={() => setSaveModalOpen(false)}
          onSave={async (name) => {
            try {
              const createPlaylist = usePlaylistStore.getState().createPlaylist;
              const pl = await createPlaylist(name, queue.map(t => t.id));
              if (pl) setActivePlaylist({ id: pl.id, name: pl.name });
              setSaveModalOpen(false);
            } catch (e) {
              console.error('Failed to save playlist', e);
            }
          }}
        />
      )}

      {loadModalOpen && (
        <LoadPlaylistModal
          onClose={() => setLoadModalOpen(false)}
          onLoad={async (id, name, mode) => {
            try {
              const data = await getPlaylist(id);
              const tracks: Track[] = data.songs.map(songToTrack);
              if (tracks.length > 0) {
                if (mode === 'append') {
                  enqueue(tracks);
                } else {
                  clearQueue();
                  playTrack(tracks[0], tracks);
                }
              }
              setActivePlaylist({ id, name });
              setLoadModalOpen(false);
            } catch (e) {
              console.error('Failed to load playlist', e);
            }
          }}
        />
      )}
    </aside>
  );
}
