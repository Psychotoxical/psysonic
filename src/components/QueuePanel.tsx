import React, { useState, useRef } from 'react';
import { Track, usePlayerStore } from '../store/playerStore';
import { Play, Music, Star, X, Trash2, Save, FolderOpen, Shuffle, Infinity, Waves, MicVocal, ListMusic } from 'lucide-react';
import { buildCoverArtUrl, getAlbum, getPlaylists, getPlaylist, createPlaylist, deletePlaylist, SubsonicPlaylist } from '../api/subsonic';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useLyricsStore } from '../store/lyricsStore';
import LyricsPane from './LyricsPane';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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

function LoadPlaylistModal({ onClose, onLoad }: { onClose: () => void, onLoad: (id: string) => void }) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<SubsonicPlaylist[]>([]);
  const [loading, setLoading] = useState(true);

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
    if (confirm(t('queue.deleteConfirm', { name }))) {
      await deletePlaylist(id);
      fetchPlaylists();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <h3 style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)' }}>{t('queue.loadPlaylist')}</h3>
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.loading')}</p>
        ) : playlists.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.noPlaylists')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
            {playlists.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--ctp-surface1)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontWeight: 500 }} className="truncate" data-tooltip={p.name}>{p.name}</span>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button className="nav-btn" onClick={() => onLoad(p.id)} data-tooltip={t('queue.load')} style={{ width: '28px', height: '28px', background: 'transparent' }}><Play size={14} /></button>
                  <button className="nav-btn" onClick={() => handleDelete(p.id, p.name)} data-tooltip={t('queue.delete')} style={{ width: '28px', height: '28px', background: 'transparent', color: 'var(--ctp-red)' }}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Module-level fallback for fromIdx — survives the dragend-before-drop race on
// macOS WKWebView AND the dataTransfer.getData('') bug on Windows WebView2.
let _dragFromIdx: number | null = null;

export default function QueuePanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const currentTime = usePlayerStore(s => s.currentTime);
  const isQueueVisible = usePlayerStore(s => s.isQueueVisible);
  const playTrack = usePlayerStore(s => s.playTrack);
  const toggleQueue = usePlayerStore(s => s.toggleQueue);
  const clearQueue = usePlayerStore(s => s.clearQueue);

  const reorderQueue = usePlayerStore(s => s.reorderQueue);
  const shuffleQueue = usePlayerStore(s => s.shuffleQueue);
  const enqueue = usePlayerStore(s => s.enqueue);
  const contextMenu = usePlayerStore(s => s.contextMenu);

  const crossfadeEnabled = useAuthStore(s => s.crossfadeEnabled);
  const crossfadeSecs = useAuthStore(s => s.crossfadeSecs);
  const gaplessEnabled = useAuthStore(s => s.gaplessEnabled);
  const setCrossfadeEnabled = useAuthStore(s => s.setCrossfadeEnabled);
  const setCrossfadeSecs = useAuthStore(s => s.setCrossfadeSecs);
  const setGaplessEnabled = useAuthStore(s => s.setGaplessEnabled);

  const activeTab  = useLyricsStore(s => s.activeTab);
  const setTab     = useLyricsStore(s => s.setTab);

  const [showRemainingTime, setShowRemainingTime] = useState(false);
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

  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const isDraggingInternalRef = useRef(false);
  // Refs mirror state so drop handler always reads fresh values even when
  // macOS WKWebView fires dragend before drop (spec violation).
  const draggedIdxRef = useRef<number | null>(null);
  const dragOverIdxRef = useRef<number | null>(null);

  const queueListRef = useRef<HTMLDivElement>(null);

  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [loadModalOpen, setLoadModalOpen] = useState(false);

  const handleSave = () => {
    if (queue.length === 0) return;
    setSaveModalOpen(true);
  };

  const handleLoad = () => {
    setLoadModalOpen(true);
  };

  const handleClear = () => {
    clearQueue();
  };

  const onDragStart = (e: React.DragEvent, index: number) => {
    isDraggingInternalRef.current = true;
    draggedIdxRef.current = index;
    _dragFromIdx = index;
    setDraggedIdx(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'queue_reorder', index }));
  };

  const onDragEnterItem = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = isDraggingInternalRef.current ? 'move' : 'copy';
  };

  const onDragOverItem = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = isDraggingInternalRef.current ? 'move' : 'copy';
    dragOverIdxRef.current = index;
    setDragOverIdx(index);
  };

  const onDragEnd = () => {
    setDraggedIdx(null);
    setDragOverIdx(null);
    isDraggingInternalRef.current = false;
    draggedIdxRef.current = null;
    dragOverIdxRef.current = null;
    // _dragFromIdx intentionally NOT cleared here — drop fires after dragend on
    // macOS WKWebView, so we need the value to survive into onDropQueue.
    // It is cleared in onDropQueue after use instead.
  };

  const onDropQueue = async (e: React.DragEvent) => {
    e.preventDefault();

    // Clear visual state immediately
    isDraggingInternalRef.current = false;
    draggedIdxRef.current = null;
    dragOverIdxRef.current = null;
    setDraggedIdx(null);
    setDragOverIdx(null);

    let parsedData: any = null;
    try {
      const raw = e.dataTransfer.getData('text/plain');
      if (raw) parsedData = JSON.parse(raw);
    } catch { /* ignore */ }

    if (parsedData?.type === 'queue_reorder' || _dragFromIdx !== null) {
      // fromIdx: prefer dataTransfer value; fall back to module-level var for
      // Windows WebView2 where getData() can return '' in the drop handler.
      const fromIdx: number = parsedData?.index ?? _dragFromIdx!;
      _dragFromIdx = null;

      // toIdx: calculate from drop coordinates — avoids all ref timing issues.
      // Works even when dragend fires before drop (macOS WKWebView / Windows WebView2).
      let toIdx = queue.length;
      if (queueListRef.current) {
        const items = queueListRef.current.querySelectorAll<HTMLElement>('[data-queue-idx]');
        for (let i = 0; i < items.length; i++) {
          const rect = items[i].getBoundingClientRect();
          if (e.clientY < rect.top + rect.height / 2) {
            toIdx = parseInt(items[i].dataset.queueIdx!);
            break;
          }
        }
      }

      if (fromIdx !== toIdx) reorderQueue(fromIdx, toIdx);
      return;
    }

    // External drop (song / album dragged from elsewhere in the app)
    _dragFromIdx = null;
    if (!parsedData) return;
    if (parsedData.type === 'song') {
      enqueue([parsedData.track]);
    } else if (parsedData.type === 'album') {
      const albumData = await getAlbum(parsedData.id);
      const tracks: Track[] = albumData.songs.map(s => ({
        id: s.id, title: s.title, artist: s.artist, album: s.album,
        albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
        year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
      }));
      enqueue(tracks);
    }
  };

  return (
    <aside
      className="queue-panel"
      onDragEnter={e => { e.preventDefault(); e.dataTransfer.dropEffect = isDraggingInternalRef.current ? 'move' : 'copy'; }}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = isDraggingInternalRef.current ? 'move' : 'copy'; }}
      onDrop={onDropQueue}
      style={{ 
        borderLeftWidth: isQueueVisible ? 1 : 0
      }}
    >
      <div className="queue-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 }}>
          <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, flexShrink: 0 }}>{t('queue.title')}</h2>
          {queue.length > 0 && (() => {
            const totalSecs = queue.reduce((acc, t) => acc + (t.duration || 0), 0);
            const remainingSecs = Math.max(0,
              (queue[queueIndex]?.duration ?? 0) - currentTime
              + queue.slice(queueIndex + 1).reduce((acc, t) => acc + (t.duration || 0), 0)
            );
            const fmt = (secs: number) => {
              const h = Math.floor(secs / 3600);
              const m = Math.floor((secs % 3600) / 60);
              const s = secs % 60;
              return h > 0
                ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
                : `${m}:${s.toString().padStart(2, '0')}`;
            };
            const dur = showRemainingTime ? `-${fmt(Math.floor(remainingSecs))}` : fmt(Math.floor(totalSecs));
            return (
              <span
                onClick={() => setShowRemainingTime(v => !v)}
                data-tooltip={showRemainingTime ? t('queue.showTotal') : t('queue.showRemaining')}
                style={{ fontSize: '13px', color: 'var(--accent)', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
              >
                {queue.length} {queue.length === 1 ? t('queue.trackSingular') : t('queue.trackPlural')} · {dur}
              </span>
            );
          })()}
        </div>
      </div>

      {currentTrack && (
        <div className="queue-current-track">
          <div className="queue-current-cover">
            {currentTrack.coverArt ? (
              <img src={buildCoverArtUrl(currentTrack.coverArt, 128)} alt="" loading="eager" />
            ) : (
              <div className="fallback"><Music size={32} /></div>
            )}
            {(currentTrack.bitRate || currentTrack.suffix) && (
              <div className="queue-current-tech">
                {currentTrack.bitRate && currentTrack.suffix
                  ? `${currentTrack.bitRate} · ${currentTrack.suffix.toUpperCase()}`
                  : currentTrack.suffix?.toUpperCase() ?? ''}
              </div>
            )}
          </div>
          <div className="queue-current-info">
            <h3 className="truncate">{currentTrack.title}</h3>
            <div
              className="queue-current-sub truncate"
              style={{ cursor: currentTrack.artistId ? 'pointer' : 'default' }}
              onClick={() => currentTrack.artistId && navigate(`/artist/${currentTrack.artistId}`)}
            >{currentTrack.artist}</div>
            <div
              className="queue-current-sub truncate"
              style={{ cursor: currentTrack.albumId ? 'pointer' : 'default' }}
              onClick={() => currentTrack.albumId && navigate(`/album/${currentTrack.albumId}`)}
            >{currentTrack.album}</div>
            {currentTrack.year && (
              <div className="queue-current-sub">{currentTrack.year}</div>
            )}
            {renderStars(currentTrack.userRating)}
          </div>
        </div>
      )}

      {activeTab === 'queue' ? (<>
        <div className="queue-toolbar">
        <button className="queue-round-btn" onClick={() => shuffleQueue()} disabled={queue.length < 2} data-tooltip={t('queue.shuffle')} aria-label={t('queue.shuffle')}>
          <Shuffle size={13} />
        </button>
        <button className="queue-round-btn" onClick={handleSave} data-tooltip={t('queue.savePlaylist')} aria-label={t('queue.savePlaylist')}>
          <Save size={13} />
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
          onClick={() => setGaplessEnabled(!gaplessEnabled)}
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
                <span className="crossfade-popover-value">{crossfadeSecs}s</span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={crossfadeSecs}
                onChange={e => {
                  setCrossfadeSecs(Number(e.target.value));
                  setCrossfadeEnabled(true);
                }}
                className="crossfade-popover-slider"
              />
              <div className="crossfade-popover-range">
                <span>1s</span><span>10s</span>
              </div>
            </div>
          )}
        </div>
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
            const isDragging = draggedIdx === idx;
            const isDragOver = dragOverIdx === idx;
            
            // Highlight above or below depending on index direction
            let dragStyle: React.CSSProperties = {};
            if (isDragging) {
              dragStyle = { opacity: 0.4, background: 'var(--bg-hover)' };
            } else if (isDragOver && draggedIdx !== null) {
              if (draggedIdx > idx) {
                dragStyle = { borderTop: '2px solid var(--accent)', paddingTop: '6px', marginTop: '-2px' };
              } else {
                dragStyle = { borderBottom: '2px solid var(--accent)', paddingBottom: '6px', marginBottom: '-2px' };
              }
            }

            return (
              <div
                key={`${track.id}-${idx}`}
                data-queue-idx={idx}
                className={`queue-item ${isPlaying ? 'active' : ''} ${contextMenu.isOpen && contextMenu.type === 'queue-item' && contextMenu.queueIndex === idx ? 'context-active' : ''}`}
                onClick={() => playTrack(track, queue)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  usePlayerStore.getState().openContextMenu(e.clientX, e.clientY, track, 'queue-item', idx);
                }}
                draggable
                onDragStart={(e) => onDragStart(e, idx)}
                onDragEnter={(e) => onDragEnterItem(e)}
                onDragOver={(e) => onDragOverItem(e, idx)}
                onDragEnd={onDragEnd}
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
            );
          })
        )}
      </div>
      </>) : (
        <LyricsPane currentTrack={currentTrack} />
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
      </div>

      {saveModalOpen && (
        <SavePlaylistModal 
          onClose={() => setSaveModalOpen(false)} 
          onSave={async (name) => { 
            try {
              await createPlaylist(name, queue.map(t => t.id));
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
          onLoad={async (id) => { 
            try {
              const data = await getPlaylist(id);
              const tracks: Track[] = data.songs.map(s => ({
                id: s.id, title: s.title, artist: s.artist, album: s.album,
                albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
                year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
              }));
              if (tracks.length > 0) {
                clearQueue();
                playTrack(tracks[0], tracks);
              }
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
