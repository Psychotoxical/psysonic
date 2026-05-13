import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Loader2, X } from 'lucide-react';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import CachedImage from '../CachedImage';

interface EditModalProps {
  playlist: SubsonicPlaylist;
  customCoverId: string | null;
  customCoverFetchUrl: string | null;
  customCoverCacheKey: string | null;
  coverQuadUrls: ({ src: string; cacheKey: string } | null)[];
  onClose: () => void;
  onSave: (opts: { name: string; comment: string; isPublic: boolean; coverFile: File | null; coverRemoved: boolean }) => Promise<void>;
}

export default function PlaylistEditModal({
  playlist, customCoverId, customCoverFetchUrl, customCoverCacheKey,
  coverQuadUrls, onClose, onSave,
}: EditModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(playlist.name);
  const [comment, setComment] = useState(playlist.comment ?? '');
  const [isPublic, setIsPublic] = useState(playlist.public ?? false);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverRemoved, setCoverRemoved] = useState(false);
  const [saving, setSaving] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const hasExistingCover = !coverRemoved && (coverPreview || customCoverId);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCoverFile(file);
    setCoverRemoved(false);
    const reader = new FileReader();
    reader.onload = ev => setCoverPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleRemoveCover = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCoverFile(null);
    setCoverPreview(null);
    setCoverRemoved(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ name, comment, isPublic, coverFile, coverRemoved });
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content playlist-edit-modal" onClick={e => e.stopPropagation()}>
        <button className="btn btn-ghost modal-close" onClick={onClose} style={{ top: 16, right: 16 }}>
          <X size={18} />
        </button>

        <h2 className="modal-title" style={{ fontSize: 22 }}>{t('playlists.editMeta')}</h2>

        <div className="playlist-edit-body">
          {/* Left: cover */}
          <div
            className="playlist-edit-cover-wrap"
            onClick={() => coverInputRef.current?.click()}
          >
            {coverPreview ? (
              <img src={coverPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : !coverRemoved && customCoverFetchUrl && customCoverCacheKey ? (
              <CachedImage
                src={customCoverFetchUrl}
                cacheKey={customCoverCacheKey}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <div className="playlist-cover-grid" style={{ width: '100%', height: '100%' }}>
                {coverQuadUrls.map((entry, i) =>
                  entry
                    ? <CachedImage key={i} className="playlist-cover-cell" src={entry.src} cacheKey={entry.cacheKey} alt="" />
                    : <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                )}
              </div>
            )}
            <div className="playlist-edit-cover-overlay">
              <div className="playlist-edit-cover-menu">
                <button
                  className="playlist-edit-cover-menu-item"
                  onClick={e => { e.stopPropagation(); coverInputRef.current?.click(); }}
                >
                  <Camera size={14} />
                  {t('playlists.changeCoverLabel')}
                </button>
                {hasExistingCover && (
                  <button
                    className="playlist-edit-cover-menu-item playlist-edit-cover-menu-item--danger"
                    onClick={handleRemoveCover}
                  >
                    {t('playlists.removeCover')}
                  </button>
                )}
              </div>
            </div>
            <input ref={coverInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
          </div>

          {/* Right: fields */}
          <div className="playlist-edit-fields">
            <input
              className="input playlist-edit-name-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('playlists.editNamePlaceholder')}
              autoFocus
            />
            <textarea
              className="input playlist-edit-desc-input"
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={t('playlists.editCommentPlaceholder')}
            />
          </div>
        </div>

        <div className="playlist-edit-footer">
          <label className="toggle-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <label className="toggle-switch" style={{ marginBottom: 0 }}>
              <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} />
              <span className="toggle-track" />
            </label>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('playlists.editPublic')}</span>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-surface" onClick={onClose}>
              {t('playlists.editCancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? <Loader2 size={14} className="spin-slow" /> : null}
              {t('playlists.editSave')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
