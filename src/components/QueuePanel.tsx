import React, { useState, useRef, useMemo } from 'react';
import { Track, usePlayerStore, songToTrack } from '../store/playerStore';
import { Play, Music, Star, X, Trash2, Save, FolderOpen, Shuffle, Infinity, Waves, MicVocal, ListMusic, Check, ListPlus, ArrowUpToLine, Radio, HardDrive, ChevronDown, Info } from 'lucide-react';
import { buildCoverArtUrl, coverArtCacheKey, getAlbum, getPlaylists, getPlaylist, updatePlaylist, deletePlaylist, SubsonicPlaylist } from '../api/subsonic';
import { usePlaylistStore } from '../store/playlistStore';
import { useCachedUrl } from './CachedImage';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { useLyricsStore } from '../store/lyricsStore';
import { useDragDrop } from '../contexts/DragDropContext';
import LyricsPane from './LyricsPane';
import NowPlayingInfo from './NowPlayingInfo';
import { TFunction } from 'i18next';

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

interface QueueHeaderProps {
  queue: Track[];
  queueIndex: number;
  showRemainingTime: boolean;
  setShowRemainingTime: React.Dispatch<React.SetStateAction<boolean>>;
  activePlaylist: { id: string; name: string } | null;
  t: TFunction;
}
function QueueHeader({ queue, queueIndex, showRemainingTime, setShowRemainingTime, activePlaylist, t }: QueueHeaderProps) {
  const currentTime = usePlayerStore((s) => s.currentTime);

  if (queue.length === 0) return null;
  const totalSecs = queue.reduce((acc: number, t: any) => acc + (t.duration || 0), 0);
  const remainingSecs = Math.max(0, (queue[queueIndex]?.duration ?? 0) - currentTime + queue.slice(queueIndex + 1).reduce((acc: number, t: any) => acc + (t.duration || 0), 0));

  const fmt = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}` : `${m}:${s.toString().padStart(2, "0")}`;
  };

  const dur = showRemainingTime ? `-${fmt(Math.floor(remainingSecs))}` : fmt(Math.floor(totalSecs));

  return (
    <div className="queue-header">
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 }}>
          <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0, flexShrink: 0 }}>{t("queue.title")}</h2>
          <span
            onClick={() => setShowRemainingTime((v: boolean) => !v)}
            data-tooltip={showRemainingTime ? t("queue.showTotal") : t("queue.showRemaining")}
            style={{
              fontSize: "13px",
              color: "var(--accent)",
              whiteSpace: "nowrap",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            {queue.length} {queue.length === 1 ? t("queue.trackSingular") : t("queue.trackPlural")} · {dur}
          </span>
        </div>
        {activePlaylist && (
          <div className="truncate" style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px", display: "flex", alignItems: "center", gap: "4px" }}>
            <ListMusic size={10} style={{ flexShrink: 0 }} />
            <span className="truncate">{activePlaylist.name}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function QueuePanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  const shuffleQueue = usePlayerStore(s => s.shuffleQueue);
  const enqueue = usePlayerStore(s => s.enqueue);
  const enqueueAt = usePlayerStore(s => s.enqueueAt);
  const contextMenu = usePlayerStore(s => s.contextMenu);

  const playbackSource = usePlayerStore(s => s.currentPlaybackSource);

  const crossfadeEnabled = useAuthStore(s => s.crossfadeEnabled);
  const crossfadeSecs = useAuthStore(s => s.crossfadeSecs);
  const gaplessEnabled = useAuthStore(s => s.gaplessEnabled);
  const infiniteQueueEnabled = useAuthStore(s => s.infiniteQueueEnabled);
  const setCrossfadeEnabled = useAuthStore(s => s.setCrossfadeEnabled);
  const setCrossfadeSecs = useAuthStore(s => s.setCrossfadeSecs);
  const setGaplessEnabled = useAuthStore(s => s.setGaplessEnabled);
  const setInfiniteQueueEnabled = useAuthStore(s => s.setInfiniteQueueEnabled);

  const activeTab  = useLyricsStore(s => s.activeTab);
  const setTab     = useLyricsStore(s => s.setTab);

  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const [showCrossfadePopover, setShowCrossfadePopover] = useState(false);
  const expandReplayGain = useThemeStore(s => s.expandReplayGain);
  const setExpandReplayGain = useThemeStore(s => s.setExpandReplayGain);
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

  // Tracks which queue index is being psy-dragged for opacity visual feedback
  const psyDragFromIdxRef = useRef<number | null>(null);

  const queueListRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

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

  useEffect(function queueAutoScroll() {
    if (!queueListRef.current || queueIndex < 0) return;
    if (activeTab !== 'queue') return;
    const songs = queueListRef.current!.querySelectorAll<HTMLElement>('[data-queue-idx]');
    const nextSong = songs[queueIndex + 1];
    if (!nextSong) return;
    nextSong.scrollIntoView({ block: "start", behavior: "instant" });
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
      <QueueHeader
        queue={queue}
        queueIndex={queueIndex}
        showRemainingTime={showRemainingTime}
        setShowRemainingTime={setShowRemainingTime}
        activePlaylist={activePlaylist}
        t={t}
      />

      {currentTrack && (
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
            if (!baseLine && !rgLine && !playbackSource) return null;
            const showRgLine = expandReplayGain && !!rgLine;
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
                    {rgLine && (
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
                  </div>
                  {showRgLine && (
                    <span className="queue-current-tech-rg">
                      <span className="queue-current-tech-rg-label">{t('queue.replayGain')}</span>
                      {' · '}{rgLine}
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
              {renderStars(userRatingOverrides[currentTrack.id] ?? currentTrack.userRating)}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'queue' ? (<>
        <div className="queue-toolbar">
        <button className="queue-round-btn" onClick={() => shuffleQueue()} disabled={queue.length < 2} data-tooltip={t('queue.shuffle')} aria-label={t('queue.shuffle')}>
          <Shuffle size={13} />
        </button>
        <button
          className={`queue-round-btn${saveState === 'saved' ? ' active' : ''}`}
          onClick={handleSave}
          disabled={saveState === 'saving'}
          data-tooltip={activePlaylist ? `${t('queue.updatePlaylist')}: ${activePlaylist.name}` : t('queue.savePlaylist')}
          aria-label={t('queue.savePlaylist')}
        >
          {saveState === 'saved' ? <Check size={13} /> : <Save size={13} />}
        </button>
        <button className="queue-round-btn" onClick={handleLoad} data-tooltip={t('queue.loadPlaylist')} aria-label={t('queue.loadPlaylist')}>
          <FolderOpen size={13} />
        </button>
        <button className="queue-round-btn" onClick={handleClear} data-tooltip={t('queue.clear')} aria-label={t('queue.clear')}>
          <Trash2 size={13} />
        </button>
        <div className="queue-toolbar-sep" />
        <button
          className={`queue-round-btn${gaplessEnabled ? ' active' : ''}`}
          onClick={() => { setCrossfadeEnabled(false); setShowCrossfadePopover(false); setGaplessEnabled(!gaplessEnabled); }}
          data-tooltip={t('queue.gapless')}
          aria-label={t('queue.gapless')}
        >
          <Infinity size={13} />
        </button>
        <div style={{ position: 'relative' }}>
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
        <button
          className={`queue-round-btn${infiniteQueueEnabled ? ' active' : ''}`}
          onClick={() => setInfiniteQueueEnabled(!infiniteQueueEnabled)}
          data-tooltip={t('queue.infiniteQueue')}
          aria-label={t('queue.infiniteQueue')}
        >
          <ArrowUpToLine size={13} />
        </button>
      </div>

      {currentTrack && queue.length > 0 && <div className="queue-divider"><span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>{t('queue.nextTracks')}</span></div>}
      
      <div className="queue-list" ref={queueListRef}>
        {queue.length === 0 ? (
          <div className="queue-empty">
            {t('queue.emptyQueue')}
          </div>
        ) : (
          queue.map((track, idx) => {
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
                onClick={() => playTrack(track, queue)}
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
                </div>
                <div className="queue-item-duration">
                  {formatTime(track.duration)}
                </div>
              </div>
              </React.Fragment>
            );
          })
        )}
      </div>
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
