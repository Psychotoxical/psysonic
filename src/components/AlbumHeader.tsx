import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Star, ExternalLink, X, ChevronLeft, Download, ListPlus, Info } from 'lucide-react';
import { SubsonicSong, buildCoverArtUrl } from '../api/subsonic';
import CachedImage from './CachedImage';
import CoverLightbox from './CoverLightbox';
import { useTranslation } from 'react-i18next';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, select, base, meta, link').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const val = attr.value.toLowerCase().trim();
      if (
        name.startsWith('on') ||
        (name === 'href' && (val.startsWith('javascript:') || val.startsWith('data:'))) ||
        (name === 'src' && (val.startsWith('javascript:') || val.startsWith('data:')))
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

function BioModal({ bio, onClose }: { bio: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('albumDetail.bioModal')}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('albumDetail.bioClose')}><X size={18} /></button>
        <h3 className="modal-title">{t('albumDetail.bioModal')}</h3>
        <div className="artist-bio" dangerouslySetInnerHTML={{ __html: sanitizeHtml(bio) }} data-selectable />
      </div>
    </div>
  );
}


interface AlbumInfo {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  year?: number;
  genre?: string;
  coverArt?: string;
  recordLabel?: string;
}

interface AlbumHeaderProps {
  info: AlbumInfo;
  songs: SubsonicSong[];
  coverUrl: string;
  coverKey: string;
  resolvedCoverUrl: string | null;
  isStarred: boolean;
  downloadProgress: number | null;
  bio: string | null;
  bioOpen: boolean;
  onToggleStar: () => void;
  onDownload: () => void;
  onPlayAll: () => void;
  onEnqueueAll: () => void;
  onBio: () => void;
  onCloseBio: () => void;
}

export default function AlbumHeader({
  info,
  songs,
  coverUrl,
  coverKey,
  resolvedCoverUrl,
  isStarred,
  downloadProgress,
  bio,
  bioOpen,
  onToggleStar,
  onDownload,
  onPlayAll,
  onEnqueueAll,
  onBio,
  onCloseBio,
}: AlbumHeaderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const totalDuration = songs.reduce((acc, s) => acc + s.duration, 0);
  const totalSize = songs.reduce((acc, s) => acc + (s.size ?? 0), 0);

  return (
    <>
      {bioOpen && bio && <BioModal bio={bio} onClose={onCloseBio} />}
      {lightboxOpen && info.coverArt && (
        <CoverLightbox
          src={buildCoverArtUrl(info.coverArt, 2000)}
          alt={`${info.name} Cover`}
          onClose={() => setLightboxOpen(false)}
        />
      )}

      <div className="album-detail-header">
        {resolvedCoverUrl && (
          <div
            className="album-detail-bg"
            style={{ backgroundImage: `url(${resolvedCoverUrl})` }}
            aria-hidden="true"
          />
        )}
        <div className="album-detail-overlay" aria-hidden="true" />

        <div className="album-detail-content">
          <button className="btn btn-ghost album-detail-back" onClick={() => navigate(-1)}>
            <ChevronLeft size={16} /> {t('albumDetail.back')}
          </button>
          <div className="album-detail-hero">
            {coverUrl ? (
              <button
                className="album-detail-cover-btn"
                onClick={() => setLightboxOpen(true)}
                data-tooltip="Vergrößern"
                aria-label={`${info.name} Cover vergrößern`}
              >
                <CachedImage className="album-detail-cover" src={coverUrl} cacheKey={coverKey} alt={`${info.name} Cover`} />
              </button>
            ) : (
              <div className="album-detail-cover album-cover-placeholder">♪</div>
            )}
            <div className="album-detail-meta">
              <span className="badge album-detail-badge">{t('common.album')}</span>
              <h1 className="album-detail-title">{info.name}</h1>
              <p className="album-detail-artist">
                <button
                  className="album-detail-artist-link"
                  data-tooltip={t('albumDetail.goToArtist', { artist: info.artist })}
                  onClick={() => navigate(`/artist/${info.artistId}`)}
                >
                  {info.artist}
                </button>
              </p>
              <div className="album-detail-info">
                {info.year && <span>{info.year}</span>}
                {info.genre && <span>· {info.genre}</span>}
                <span>· {songs.length} Tracks</span>
                <span>· {formatDuration(totalDuration)}</span>
                {info.recordLabel && (
                  <>
                    <span className="album-info-dot">·</span>
                    <button
                      className="album-detail-artist-link"
                      data-tooltip={t('albumDetail.moreLabelAlbums', { label: info.recordLabel })}
                      onClick={() => navigate(`/label/${encodeURIComponent(info.recordLabel!)}`)}
                    >
                      {info.recordLabel}
                    </button>
                  </>
                )}
              </div>
              <div className="album-detail-actions">
                <div className="album-detail-actions-primary">
                  <button className="btn btn-primary" id="album-play-all-btn" onClick={onPlayAll}>
                    <Play size={16} fill="currentColor" /> {t('albumDetail.playAll')}
                  </button>
                  <button
                    className="btn btn-surface"
                    onClick={onEnqueueAll}
                    data-tooltip={t('albumDetail.enqueueTooltip')}
                  >
                    <ListPlus size={16} /> {t('albumDetail.enqueue')}
                  </button>
                </div>

                <button
                  className="btn btn-ghost"
                  id="album-star-btn"
                  onClick={onToggleStar}
                  data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                  style={{ color: isStarred ? 'var(--color-star-active, var(--accent))' : 'inherit', border: isStarred ? '1px solid var(--color-star-active, var(--accent))' : undefined }}
                >
                  <Star size={16} fill={isStarred ? 'currentColor' : 'none'} />
                  {t('albumDetail.favorite')}
                </button>

                <button className="btn btn-ghost" id="album-bio-btn" onClick={onBio}>
                  <ExternalLink size={16} /> {t('albumDetail.artistBio')}
                </button>

                {downloadProgress !== null ? (
                  <div className="download-progress-wrap">
                    <Download size={14} />
                    <div className="download-progress-bar">
                      <div className="download-progress-fill" style={{ width: `${downloadProgress}%` }} />
                    </div>
                    <span className="download-progress-pct">{downloadProgress}%</span>
                  </div>
                ) : (
                  <button className="btn btn-ghost" id="album-download-btn" onClick={onDownload}>
                    <Download size={16} /> {t('albumDetail.download')}{totalSize > 0 ? ` · ${formatSize(totalSize)}` : ''}
                  </button>
                )}
                <span className="download-hint">
                  <Info size={12} />
                  {t('albumDetail.downloadHintShort')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
