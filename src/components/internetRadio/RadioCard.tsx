import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Cast, Globe, Heart, Trash2, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import type { InternetRadioStation } from '../../api/subsonicTypes';
import { useDragDrop, useDragSource } from '../../contexts/DragDropContext';
import CachedImage from '../CachedImage';

interface RadioCardProps {
  s: InternetRadioStation;
  isActive: boolean;
  isPlaying: boolean;
  deleteConfirmId: string | null;
  isFavorite: boolean;
  isManual: boolean;
  dropIndicator: 'before' | 'after' | null;
  onPlay: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onEdit: () => void;
  onFavoriteToggle: () => void;
  onDragEnter: (side: 'before' | 'after') => void;
  onDragLeave: () => void;
  onDropOnto: (srcId: string, side: 'before' | 'after') => void;
  onCardMouseLeave: () => void;
}

export default function RadioCard({
  s, isActive, isPlaying, deleteConfirmId, isFavorite, isManual, dropIndicator,
  onPlay, onDelete, onEdit, onFavoriteToggle, onDragEnter, onDragLeave,
  onDropOnto, onCardMouseLeave,
}: RadioCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const lastSideRef = useRef<'before' | 'after'>('after');
  const { isDragging, payload } = useDragDrop();
  const isBeingDragged = isDragging && !!payload && (() => {
    try { return JSON.parse(payload.data).id === s.id; } catch { return false; }
  })();

  const dragHandlers = useDragSource(() => ({
    data: JSON.stringify({ type: 'radio', id: s.id }),
    label: s.name,
  }));

  // Calculate which half of the card the cursor is on
  const getSide = (e: React.MouseEvent): 'before' | 'after' => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return 'after';
    return e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  };

  // psy-drop listener: fires when a drag is released over this card
  useEffect(() => {
    if (!isManual) return;
    const el = cardRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const data = JSON.parse((e as CustomEvent).detail?.data ?? '{}');
      if (data.type === 'radio' && data.id !== s.id) onDropOnto(data.id, lastSideRef.current);
    };
    el.addEventListener('psy-drop', handler);
    return () => el.removeEventListener('psy-drop', handler);
  }, [isManual, s.id, onDropOnto]);

  return (
    <div
      ref={cardRef}
      className={[
        'album-card radio-card',
        isActive ? 'radio-card-active' : '',
        dropIndicator === 'before' ? 'radio-card-drop-before' : '',
        dropIndicator === 'after' ? 'radio-card-drop-after' : '',
      ].filter(Boolean).join(' ')}
      style={{ cursor: isManual ? 'grab' : 'default', opacity: isBeingDragged ? 0.4 : 1 }}
      {...(isManual ? dragHandlers : {})}
      onMouseMove={e => {
        if (!isDragging || !isManual) return;
        const side = getSide(e);
        lastSideRef.current = side;
        onDragEnter(side);
      }}
      onMouseLeave={() => { onDragLeave(); onCardMouseLeave(); }}
    >
      {/* Cover */}
      <div className="album-card-cover">
        {s.coverArt ? (
          <CachedImage
            src={buildCoverArtUrl(`ra-${s.id}`, 256)}
            cacheKey={coverArtCacheKey(`ra-${s.id}`, 256)}
            alt={s.name}
            className="album-card-cover-img"
          />
        ) : (
          <div className="album-card-cover-placeholder playlist-card-icon">
            <Cast size={48} strokeWidth={1.2} />
          </div>
        )}

        {isActive && isPlaying && (
          <div className="radio-live-overlay">
            <span className="radio-live-badge">{t('radio.live')}</span>
          </div>
        )}

        <div className="album-card-play-overlay">
          <button className="album-card-details-btn" onClick={onPlay}>
            {isActive && isPlaying ? <X size={15} /> : <Cast size={14} />}
          </button>
        </div>

        <button
          className={`playlist-card-delete ${deleteConfirmId === s.id ? 'playlist-card-delete--confirm' : ''}`}
          onClick={onDelete}
          data-tooltip={deleteConfirmId === s.id ? t('radio.confirmDelete') : t('radio.deleteStation')}
          data-tooltip-pos="bottom"
        >
          {deleteConfirmId === s.id ? <Trash2 size={12} /> : <X size={12} />}
        </button>
      </div>

      {/* Info */}
      <div className="album-card-info">
        <div className="album-card-title">{s.name}</div>
        <div className="album-card-artist" style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
          <button className="radio-card-chip" onClick={onEdit}>
            {t('radio.editStation')}
          </button>
          <button
            className={`player-btn player-btn-sm radio-favorite-btn${isFavorite ? ' active' : ''}`}
            onClick={e => { e.stopPropagation(); onFavoriteToggle(); }}
            data-tooltip={t(isFavorite ? 'radio.unfavorite' : 'radio.favorite')}
          >
            <Heart size={11} fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
          {s.homepageUrl && (
            <button
              className="player-btn player-btn-sm"
              style={{ opacity: 0.6 }}
              onClick={() => open(s.homepageUrl!)}
              data-tooltip={t('radio.openHomepage')}
            >
              <Globe size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
