import { star, unstar } from '../api/subsonicStarRating';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { emit } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { Play, Trash2, Disc3, User, Heart, Info } from 'lucide-react';
import type { MiniTrackInfo } from '../utils/miniPlayerBridge';

interface Props {
  x: number;
  y: number;
  track: MiniTrackInfo;
  index: number;
  onClose: () => void;
}

/**
 * Slim queue-item context menu for the mini player. The mini lives in its
 * own webview, so all queue mutations forward to the main window via Tauri
 * events; only the favorite call hits Subsonic directly because it has no
 * cross-window state to keep in sync (next mini:sync from main reflects the
 * new starred flag).
 */
export default function MiniContextMenu({ x, y, track, index, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [starred, setStarred] = useState(!!track.starred);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp the menu inside the mini window's viewport (it pops near the
  // cursor and would otherwise overflow at the right/bottom edges of the
  // small window).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(x, Math.max(4, vw - r.width - 4));
    const top = Math.min(y, Math.max(4, vh - r.height - 4));
    setPos({ left, top });
  }, [x, y]);

  // Dismiss on outside click + Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (fn: () => void | Promise<void>) => {
    Promise.resolve(fn()).finally(onClose);
  };

  const toggleStar = async () => {
    const next = !starred;
    setStarred(next);
    try {
      if (next) await star(track.id, 'song');
      else await unstar(track.id, 'song');
    } catch {
      setStarred(!next);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="context-menu mini-context-menu"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 99998 }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="context-menu-item" onClick={() => run(() => emit('mini:jump', { index }))}>
        <Play size={14} /> {t('contextMenu.playNow')}
      </div>
      <div
        className="context-menu-item"
        style={{ color: 'var(--danger)' }}
        onClick={() => run(() => emit('mini:remove', { index }))}
      >
        <Trash2 size={14} /> {t('contextMenu.removeFromQueue')}
      </div>
      <div className="context-menu-divider" />
      {track.albumId && (
        <div
          className="context-menu-item"
          onClick={() => run(() => emit('mini:navigate', { to: `/album/${track.albumId}` }))}
        >
          <Disc3 size={14} /> {t('contextMenu.openAlbum')}
        </div>
      )}
      {track.artistId && (
        <div
          className="context-menu-item"
          onClick={() => run(() => emit('mini:navigate', { to: `/artist/${track.artistId}` }))}
        >
          <User size={14} /> {t('contextMenu.goToArtist')}
        </div>
      )}
      <div className="context-menu-item" onClick={() => run(toggleStar)}>
        <Heart size={14} fill={starred ? 'currentColor' : 'none'} />
        {starred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
      </div>
      <div className="context-menu-divider" />
      <div
        className="context-menu-item"
        onClick={() => run(() => emit('mini:song-info', { id: track.id }))}
      >
        <Info size={14} /> {t('contextMenu.songInfo')}
      </div>
    </div>,
    document.body,
  );
}
