import { buildCoverArtUrl } from '../api/subsonicStreamUrl';
import type { EntityRatingSupportLevel, SubsonicOpenArtistRef, SubsonicSong } from '../api/subsonicTypes';
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Play, Heart, ExternalLink, X, ChevronLeft, Download, ListPlus, HardDriveDownload, Share2, Highlighter, Loader2, Shuffle } from 'lucide-react';
import CachedImage from './CachedImage';
import CoverLightbox from './CoverLightbox';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../hooks/useIsMobile';
import { useThemeStore } from '../store/themeStore';
import StarRating from './StarRating';
import { copyEntityShareLink } from '../utils/share/copyEntityShareLink';
import { showToast } from '../utils/ui/toast';
import { isAlbumRecentlyAdded } from '../utils/albumRecency';
import { formatLongDuration } from '../utils/format/formatDuration';
import { formatMb } from '../utils/format/formatBytes';
import { sanitizeHtml } from '../utils/sanitizeHtml';
import { OpenArtistRefInline } from './OpenArtistRefInline';

/** True when the album artist label means "no single artist" — `getArtistInfo`
 *  has nothing meaningful to return for these, so the Artist Bio entry is hidden.
 */
function isVariousArtistsLabel(name: string | undefined | null): boolean {
  if (!name) return false;
  const trimmed = name.trim().toLowerCase();
  return (
    trimmed === 'various artists' ||
    trimmed === 'various' ||
    trimmed === 'va' ||
    trimmed === 'multiple artists' ||
    trimmed === 'verschiedene interpreten' ||
    trimmed === 'verschiedene'
  );
}

function BioModal({ bio, onClose }: { bio: string; onClose: () => void }) {
  const { t } = useTranslation();
  return createPortal(
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('albumDetail.bioModal')}>
      <div className="modal-content bio-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('albumDetail.bioClose')}><X size={18} /></button>
        <h3 className="modal-title">{t('albumDetail.bioModal')}</h3>
        <div className="bio-modal-body">
          <div className="artist-bio" dangerouslySetInnerHTML={{ __html: sanitizeHtml(bio) }} data-selectable />
        </div>
      </div>
    </div>,
    document.body
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
  created?: string;
}

interface AlbumHeaderProps {
  info: AlbumInfo;
  /** OpenSubsonic album credits (derived from album + songs). */
  headerArtistRefs: SubsonicOpenArtistRef[];
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
  headerArtistRefs,
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
  const isNewAlbum = isAlbumRecentlyAdded(info.created);
  const showBioButton = !isVariousArtistsLabel(info.artist);

  const lightboxCoverSrc = useMemo(
    () => (info.coverArt ? buildCoverArtUrl(info.coverArt, 2000) : ''),
    [info.coverArt],
  );

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
          src={lightboxCoverSrc}
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
              {isNewAlbum && (
                <span className="badge album-detail-badge">{t('common.new', 'New')}</span>
              )}
              <h1 className="album-detail-title">{info.name}</h1>
              <p className="album-detail-artist">
                <OpenArtistRefInline
                  refs={headerArtistRefs}
                  fallbackName={info.artist}
                  onGoArtist={id => navigate(`/artist/${id}`)}
                  linkClassName="album-detail-artist-link"
                />
              </p>
              <div className="album-detail-info">
                {info.year && <span>{info.year}</span>}
                {info.genre && <span>· {info.genre}</span>}
                <span>· {songs.length} Tracks</span>
                <span>· {formatLongDuration(totalDuration)}</span>
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

                    {showBioButton && (
                      <button
                        className="album-icon-btn album-icon-btn--sm"
                        onClick={onBio}
                        aria-label={t('albumDetail.artistBio')}
                        data-tooltip={t('albumDetail.artistBio')}
                      >
                        <Highlighter size={16} />
                      </button>
                    )}

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

                  {showBioButton && (
                    <button className="btn btn-ghost" id="album-bio-btn" onClick={onBio}>
                      <Highlighter size={16} /> {t('albumDetail.artistBio')}
                    </button>
                  )}

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
                      <Download size={16} /> {t('albumDetail.download')}{totalSize > 0 ? ` · ${formatMb(totalSize)}` : ''}
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
