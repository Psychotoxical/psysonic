import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Heart, ExternalLink, X, ChevronLeft, Download, ListPlus, HardDriveDownload, Loader2, Highlighter, Shuffle, Share2 } from 'lucide-react';
import { SubsonicSong, buildCoverArtUrl } from '../api/subsonic';
import CachedImage from './CachedImage';
import CoverLightbox from './CoverLightbox';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../hooks/useIsMobile';
import { useThemeStore } from '../store/themeStore';
import StarRating from './StarRating';
import type { EntityRatingSupportLevel } from '../api/subsonic';
import { copyEntityShareLink } from '../utils/copyEntityShareLink';
import { showToast } from '../utils/toast';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
  offlineStatus: 'none' | 'downloading' | 'cached';
  offlineProgress: { done: number; total: number } | null;
  bio: string | null;
  bioOpen: boolean;
  onToggleStar: () => void;
  onDownload: () => void;
  onCacheOffline: () => void;
  onRemoveOffline: () => void;
  onPlayAll: () => void;
  onEnqueueAll: () => void;
  onShuffleAll?: () => void;
  onBio: () => void;
  onCloseBio: () => void;
  entityRatingValue: number;
  onEntityRatingChange: (rating: number) => void;
  /** `unknown` = probe pending or not run; from `entityRatingSupportByServer`. */
  entityRatingSupport: EntityRatingSupportLevel | 'unknown';
}

export default function AlbumHeader({
  info,
  songs,
  coverUrl,
  coverKey,
  resolvedCoverUrl,
  isStarred,
  downloadProgress,
  offlineStatus,
  offlineProgress,
  bio,
  bioOpen,
  onToggleStar,
  onDownload,
  onCacheOffline,
  onRemoveOffline,
  onPlayAll,
  onEnqueueAll,
  onShuffleAll,
  onBio,
  onCloseBio,
  entityRatingValue,
  onEntityRatingChange,
  entityRatingSupport,
}: AlbumHeaderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const enableCoverArtBackground = useThemeStore(s => s.enableCoverArtBackground);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const totalDuration = songs.reduce((acc, s) => acc + s.duration, 0);
  const totalSize = songs.reduce((acc, s) => acc + (s.size ?? 0), 0);
  const formatLabel = [...new Set(songs.map(s => s.suffix).filter((f): f is string => !!f))].map(f => f.toUpperCase()).join(' / ');

  const handleShareAlbum = async () => {
    try {
      const ok = await copyEntityShareLink('album', info.id);
      if (ok) showToast(t('contextMenu.shareCopied'));
      else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
    } catch {
      showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
    }
  };

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
        {resolvedCoverUrl && enableCoverArtBackground && (
          <>
            <div
              className="album-detail-bg"
              style={{ backgroundImage: `url(${resolvedCoverUrl})` }}
              aria-hidden="true"
            />
            <div className="album-detail-overlay" aria-hidden="true" />
          </>
        )}

        <div className="album-detail-content">
          <button className="btn btn-ghost album-detail-back" onClick={() => navigate(-1)}>
            <ChevronLeft size={16} /> {t('albumDetail.back')}
          </button>
          <div className="album-detail-hero">
            {coverUrl ? (
              <button
                className="album-detail-cover-btn"
                onClick={() => setLightboxOpen(true)}
                data-tooltip={t('albumDetail.enlargeCover')}
                aria-label={`${info.name} ${t('albumDetail.enlargeCover')}`}
              >
                <CachedImage className="album-detail-cover" src={coverUrl} cacheKey={coverKey} alt={`${info.name} Cover`} />
              </button>
            ) : (
              <div className="album-detail-cover album-cover-placeholder">♪</div>
            )}
            <div className="album-detail-meta">
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
                {formatLabel && <span>· {formatLabel}</span>}
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
              <div className="album-detail-entity-rating">
                <span className="album-detail-entity-rating-label">{t('entityRating.albumShort')}</span>
                <StarRating
                  value={entityRatingValue}
                  onChange={onEntityRatingChange}
                  disabled={entityRatingSupport === 'track_only'}
                  labelKey="entityRating.albumAriaLabel"
                />
              </div>
              {isMobile ? (
                <div className="album-detail-actions-mobile">
                  {/* Row 1 — Primary actions */}
                  <div className="album-actions-row album-actions-row--primary">
                    <button
                      className="album-icon-btn album-icon-btn--play"
                      onClick={onPlayAll}
                      aria-label={t('albumDetail.playAll')}
                      data-tooltip={t('albumDetail.playAll')}
                    >
                      <Play size={24} fill="currentColor" />
                    </button>
                    <button
                      className="album-icon-btn album-icon-btn--queue"
                      onClick={onEnqueueAll}
                      aria-label={t('albumDetail.enqueue')}
                      data-tooltip={t('albumDetail.enqueueTooltip')}
                    >
                      <ListPlus size={20} />
                    </button>
                  </div>

                  {/* Row 2 — Secondary actions */}
                  <div className="album-actions-row album-actions-row--secondary">
                    <button
                      className={`album-icon-btn album-icon-btn--sm${isStarred ? ' is-starred' : ''}`}
                      onClick={onToggleStar}
                      aria-label={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                      data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                    >
                      <Heart size={16} fill={isStarred ? 'currentColor' : 'none'} />
                    </button>

                    <button
                      className="album-icon-btn album-icon-btn--sm"
                      type="button"
                      onClick={handleShareAlbum}
                      aria-label={t('albumDetail.shareAlbum')}
                      data-tooltip={t('albumDetail.shareAlbum')}
                    >
                      <Share2 size={16} />
                    </button>

                    <button
                      className="album-icon-btn album-icon-btn--sm"
                      onClick={onBio}
                      aria-label={t('albumDetail.artistBio')}
                      data-tooltip={t('albumDetail.artistBio')}
                    >
                      <Highlighter size={16} />
                    </button>

                    {downloadProgress !== null ? (
                      <div className="album-icon-btn album-icon-btn--sm album-icon-btn--progress">
                        <Download size={14} />
                        <span className="album-icon-btn-pct">{downloadProgress}%</span>
                      </div>
                    ) : (
                      <button
                        className="album-icon-btn album-icon-btn--sm"
                        onClick={onDownload}
                        aria-label={t('albumDetail.download')}
                        data-tooltip={t('albumDetail.download')}
                      >
                        <Download size={16} />
                      </button>
                    )}

                    {offlineStatus === 'downloading' ? (
                      <div className="album-icon-btn album-icon-btn--sm album-icon-btn--progress">
                        <Loader2 size={14} className="spin" />
                      </div>
                    ) : offlineStatus === 'cached' ? (
                      <button
                        className="album-icon-btn album-icon-btn--sm album-icon-btn--active"
                        onClick={onRemoveOffline}
                        aria-label={t('albumDetail.offlineCached')}
                        data-tooltip={t('albumDetail.removeOffline')}
                      >
                        <HardDriveDownload size={16} />
                      </button>
                    ) : (
                      <button
                        className="album-icon-btn album-icon-btn--sm"
                        onClick={onCacheOffline}
                        aria-label={t('albumDetail.cacheOffline')}
                        data-tooltip={t('albumDetail.cacheOffline')}
                      >
                        <HardDriveDownload size={16} />
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="album-detail-actions">
                  <div className="album-detail-actions-primary">
                    <button className="btn btn-primary" id="album-play-all-btn" onClick={onPlayAll}>
                      <Play size={15} /> {t('common.play', 'Reproducir')}
                    </button>
                    {onShuffleAll && (
                      <button
                        className="btn btn-ghost"
                        onClick={onShuffleAll}
                        data-tooltip={t('playlists.shuffle', 'Shuffle')}
                      >
                        <Shuffle size={16} />
                      </button>
                    )}
                    <button
                      className="btn btn-ghost"
                      onClick={onEnqueueAll}
                      data-tooltip={t('albumDetail.enqueueTooltip')}
                    >
                      <ListPlus size={16} />
                    </button>
                    <button
                      className={`btn btn-ghost${isStarred ? ' is-starred' : ''}`}
                      onClick={onToggleStar}
                      data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                    >
                      <Heart size={16} fill={isStarred ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={handleShareAlbum}
                      aria-label={t('albumDetail.shareAlbum')}
                      data-tooltip={t('albumDetail.shareAlbum')}
                    >
                      <Share2 size={16} />
                    </button>
                  </div>

                  <button className="btn btn-ghost" id="album-bio-btn" onClick={onBio}>
                    <Highlighter size={16} /> {t('albumDetail.artistBio')}
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
                  {offlineStatus === 'downloading' && offlineProgress ? (
                    <div className="offline-cache-btn offline-cache-btn--progress">
                      <Loader2 size={14} className="spin" />
                      {t('albumDetail.offlineDownloading', { n: offlineProgress.done, total: offlineProgress.total })}
                    </div>
                  ) : offlineStatus === 'cached' ? (
                    <button
                      className="btn btn-ghost offline-cache-btn offline-cache-btn--cached"
                      onClick={onRemoveOffline}
                      data-tooltip={t('albumDetail.removeOffline')}
                    >
                      <HardDriveDownload size={16} />
                      {t('albumDetail.offlineCached')}
                    </button>
                  ) : (
                    <button
                      className="btn btn-ghost offline-cache-btn"
                      onClick={onCacheOffline}
                      data-tooltip={t('albumDetail.cacheOffline')}
                    >
                      <HardDriveDownload size={16} />
                      {t('albumDetail.cacheOffline')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
