import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Cast, Loader2, X } from 'lucide-react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import type { InternetRadioStation } from '../../api/subsonicTypes';
import CachedImage from '../CachedImage';

interface RadioEditModalProps {
  station: InternetRadioStation | null; // null = create new
  onClose: () => void;
  onSave: (opts: {
    name: string;
    streamUrl: string;
    homepageUrl: string;
    coverFile: File | null;
    coverRemoved: boolean;
  }) => Promise<void>;
}

export default function RadioEditModal({ station, onClose, onSave }: RadioEditModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(station?.name ?? '');
  const [streamUrl, setStreamUrl] = useState(station?.streamUrl ?? '');
  const [homepageUrl, setHomepageUrl] = useState(station?.homepageUrl ?? '');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverRemoved, setCoverRemoved] = useState(false);
  const [saving, setSaving] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const hasExistingCover = !coverRemoved && (coverPreview || station?.coverArt);

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
    if (!name.trim() || !streamUrl.trim()) return;
    setSaving(true);
    try {
      await onSave({ name, streamUrl, homepageUrl, coverFile, coverRemoved });
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" style={{ alignItems: 'center', paddingTop: 0, overflowY: 'auto' }} onClick={handleOverlayClick}>
      <div
        className="modal-content"
        style={{ maxWidth: 440, width: '90%', maxHeight: 'none', overflow: 'visible' }}
        onClick={e => e.stopPropagation()}
      >
        <button className="btn btn-ghost modal-close" onClick={onClose} style={{ top: 16, right: 16 }}>
          <X size={18} />
        </button>

        <h2 className="modal-title" style={{ fontSize: 20 }}>
          {station ? t('radio.editStation') : t('radio.addStation')}
        </h2>

        {/* Cover + fields side by side */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 20 }}>
          {/* Cover */}
          <div
            className="playlist-edit-cover-wrap"
            style={{ width: 140, height: 140 }}
            onClick={() => coverInputRef.current?.click()}
          >
            {coverPreview ? (
              <img src={coverPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : !coverRemoved && station?.coverArt ? (
              <CachedImage
                src={buildCoverArtUrl(`ra-${station.id}`, 256)}
                cacheKey={coverArtCacheKey(`ra-${station.id}`, 256)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <div className="album-card-cover-placeholder playlist-card-icon" style={{ width: '100%', height: '100%', borderRadius: 0 }}>
                <Cast size={36} strokeWidth={1.2} />
              </div>
            )}
            <div className="playlist-edit-cover-overlay">
              <div className="playlist-edit-cover-menu">
                <button
                  className="playlist-edit-cover-menu-item"
                  onClick={e => { e.stopPropagation(); coverInputRef.current?.click(); }}
                >
                  <Camera size={13} />
                  {t('radio.changeCoverLabel')}
                </button>
                {hasExistingCover && (
                  <button
                    className="playlist-edit-cover-menu-item playlist-edit-cover-menu-item--danger"
                    onClick={handleRemoveCover}
                  >
                    {t('radio.removeCover')}
                  </button>
                )}
              </div>
            </div>
            <input ref={coverInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
          </div>

          {/* Fields */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              className="input"
              style={{ fontSize: 15, fontWeight: 600 }}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('radio.stationName')}
              autoFocus
            />
            <input
              className="input"
              value={streamUrl}
              onChange={e => setStreamUrl(e.target.value)}
              placeholder={t('radio.streamUrl')}
            />
            <input
              className="input"
              value={homepageUrl}
              onChange={e => setHomepageUrl(e.target.value)}
              placeholder={t('radio.homepageUrl')}
            />
          </div>
        </div>

        <div className="playlist-edit-footer">
          <div />
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !streamUrl.trim()}
          >
            {saving ? <Loader2 size={14} className="spin-slow" /> : null}
            {t('radio.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
