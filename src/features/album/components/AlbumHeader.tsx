import type { EntityRatingSupportLevel, SubsonicItemGenre, SubsonicOpenArtistRef, SubsonicSong } from '@/lib/api/subsonicTypes';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Play, Heart, X, ChevronLeft, Download, ListPlus, HardDriveDownload, Share2, Highlighter, Loader2, Shuffle } from 'lucide-react';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import { useCoverLightboxSrc } from '@/cover/lightbox';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useAlbumDetailBack } from '@/features/album/hooks/useAlbumDetailBack';
import { useThemeStore } from '@/store/themeStore';
import StarRating from '@/ui/StarRating';
import { copyEntityShareLink } from '@/lib/share/copyEntityShareLink';
import { showToast } from '@/lib/dom/toast';
import { isAlbumRecentlyAdded } from '@/features/album/utils/albumRecency';
import { formatLongDuration } from '@/lib/format/formatDuration';
import { formatMb } from '@/lib/format/formatBytes';
import { sanitizeHtml } from '@/lib/util/sanitizeHtml';
import { OpenArtistRefInline } from '@/ui/OpenArtistRefInline';
import { tooltipAttrs } from '@/ui/tooltipAttrs';
import { offlineActionPolicy, type OfflineActionPolicy } from '@/features/offline';
import { deriveAlbumGenreTags } from '@/lib/library/genreTags';
import { genreColor } from '@/lib/library/genreColor';

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


/** Cursor-anchored genre list (context-menu style) for the "+N" chip. */
function GenreMenu({
  genres, pos, onPick, onClose,
}: {
  genres: string[];
  pos: { x: number; y: number };
  onPick: (genre: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState(pos);

  // Clamp into the viewport once the menu has measured its own size, then move
  // focus to the first genre so keyboard users land inside the menu.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    setCoords({
      x: Math.max(pad, Math.min(pos.x, window.innerWidth - rect.width - pad)),
      y: Math.max(pad, Math.min(pos.y, window.innerHeight - rect.height - pad)),
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      const items = Array.from(
        ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
      );
      if (items.length === 0) return;
      const focusAt = (i: number) => items[(i + items.length) % items.length].focus();
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(at + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(at < 0 ? -1 : at - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
      else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1); }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="genre-menu"
      role="menu"
      aria-label={t('albumDetail.genresModalTitle')}
      style={{ left: coords.x, top: coords.y }}
    >
      {genres.map(g => (
        <button
          key={g}
          type="button"
          role="menuitem"
          className="genre-menu-item"
          style={{ '--genre-color': genreColor(g) } as CSSProperties}
          onClick={() => onPick(g)}
        >
          {g}
        </button>
      ))}
    </div>,
    document.body,
  );
}

interface AlbumInfo {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  year?: number;
  genre?: string;
  /** OpenSubsonic atomic genres — preferred over the legacy `genre` string. */
  genres?: SubsonicItemGenre[];
  coverArt?: string;
  recordLabel?: string;
  created?: string;
}

interface AlbumHeaderProps {
  info: AlbumInfo;
  /** OpenSubsonic album credits (derived from album + songs). */
  headerArtistRefs: SubsonicOpenArtistRef[];
  songs: SubsonicSong[];
  coverArtId?: string;
  resolvedCoverUrl: string | null;
  isStarred: boolean;
  downloadProgress: number | null;
  offlineStatus: 'none' | 'queued' | 'downloading' | 'cached';
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
  /** Offline browse action gates (favorites, download, cache, bio, ratings). */
  actionPolicy?: OfflineActionPolicy;
}

export default function AlbumHeader({
  info,
  headerArtistRefs,
  songs,
  coverArtId,
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
  actionPolicy,
}: AlbumHeaderProps) {
  const policy = actionPolicy ?? offlineActionPolicy('albumDetail', false);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const goBack = useAlbumDetailBack();
  const isMobile = useIsMobile();
  const enableCoverArtBackground = useThemeStore(s => s.enableCoverArtBackground);

  const coverRef = useAlbumCoverRef(info.id, coverArtId, undefined, { libraryResolve: true });
  const { open: openLightbox, lightbox } = useCoverLightboxSrc(coverRef, {
    alt: `${info.name} Cover`,
  });

  const totalDuration = songs.reduce((acc, s) => acc + s.duration, 0);
  const totalSize = songs.reduce((acc, s) => acc + (s.size ?? 0), 0);
  const formatLabel = [...new Set(songs.map(s => s.suffix).filter((f): f is string => !!f))].map(f => f.toUpperCase()).join(' / ');
  const isNewAlbum = isAlbumRecentlyAdded(info.created);
  const showBioButton = !isVariousArtistsLabel(info.artist);
  const genreTags = deriveAlbumGenreTags(info, songs);
  const [genreMenuPos, setGenreMenuPos] = useState<{ x: number; y: number } | null>(null);
  const genreMoreRef = useRef<HTMLButtonElement>(null);
  const goToGenre = (genre: string) => {
    setGenreMenuPos(null);
    navigate(`/genres/${encodeURIComponent(genre)}`, { state: { returnTo: `/album/${info.id}` } });
  };

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
      {lightbox}

      {genreMenuPos && (
        <GenreMenu
          genres={genreTags.slice(1)}
          pos={genreMenuPos}
          onPick={goToGenre}
          onClose={() => {
            setGenreMenuPos(null);
            genreMoreRef.current?.focus();
          }}
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
          <button className="btn btn-ghost album-detail-back" onClick={goBack}>
            <ChevronLeft size={16} /> {t('albumDetail.back')}
          </button>
          <div className="album-detail-hero">
            {coverRef ? (
              <button
                className="album-detail-cover-btn"
                onClick={openLightbox}
                data-tooltip={t('albumDetail.enlargeCover')}
                aria-label={`${info.name} ${t('albumDetail.enlargeCover')}`}
              >
                <CoverArtImage
                  className="album-detail-cover"
                  coverRef={coverRef}
                  displayCssPx={400}
                  surface="sparse"
                  alt={`${info.name} Cover`}
                />
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
              {genreTags.length > 0 && (
                <div className="album-detail-genre-row">
                  <button
                    className="album-detail-genre-pill"
                    data-tooltip={t('albumDetail.moreGenreAlbums', { genre: genreTags[0] })}
                    aria-label={t('albumDetail.moreGenreAlbums', { genre: genreTags[0] })}
                    onClick={() => goToGenre(genreTags[0])}
                  >
                    {genreTags[0]}
                  </button>
                  {genreTags.length > 1 && (
                    <button
                      ref={genreMoreRef}
                      className="album-detail-genre-pill"
                      data-tooltip={t('albumDetail.showAllGenres')}
                      aria-label={t('albumDetail.showAllGenres')}
                      aria-haspopup="menu"
                      aria-expanded={genreMenuPos != null}
                      onClick={e => {
                        // Keyboard activation (Enter/Space) reports clientX/Y = 0 →
                        // anchor below the chip instead of the viewport corner.
                        if (e.detail === 0) {
                          const r = e.currentTarget.getBoundingClientRect();
                          setGenreMenuPos({ x: r.left, y: r.bottom + 4 });
                        } else {
                          setGenreMenuPos({ x: e.clientX, y: e.clientY });
                        }
                      }}
                    >
                      {`+${genreTags.length - 1}`}
                    </button>
                  )}
                </div>
              )}
              <div className="album-detail-info">
                {info.year && <span>{info.year}</span>}
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
                  disabled={!policy.canRate || entityRatingSupport === 'track_only'}
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
                    {policy.canFavorite && (
                      <button
                        className={`album-icon-btn album-icon-btn--sm${isStarred ? ' is-starred' : ''}`}
                        onClick={onToggleStar}
                        aria-label={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                        data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                      >
                        <Heart size={16} fill={isStarred ? 'currentColor' : 'none'} />
                      </button>
                    )}

                    <button
                      className="album-icon-btn album-icon-btn--sm"
                      type="button"
                      onClick={handleShareAlbum}
                      aria-label={t('albumDetail.shareAlbum')}
                      data-tooltip={t('albumDetail.shareAlbum')}
                    >
                      <Share2 size={16} />
                    </button>

                    {showBioButton && policy.canShowBio && (
                      <button
                        className="album-icon-btn album-icon-btn--sm"
                        onClick={onBio}
                        aria-label={t('albumDetail.artistBio')}
                        data-tooltip={t('albumDetail.artistBio')}
                      >
                        <Highlighter size={16} />
                      </button>
                    )}

                    {policy.canDownload && (
                      downloadProgress !== null ? (
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
                      )
                    )}

                    {policy.canPinOffline && (
                      offlineStatus === 'downloading' ? (
                        <div className="album-icon-btn album-icon-btn--sm album-icon-btn--progress">
                          <Loader2 size={14} className="spin" />
                        </div>
                      ) : offlineStatus === 'queued' ? (
                        <button
                          className="album-icon-btn album-icon-btn--sm album-icon-btn--active"
                          onClick={onCacheOffline}
                          aria-label={t('albumDetail.offlineQueued')}
                          data-tooltip={t('albumDetail.removeFromOfflineQueue')}
                        >
                          <HardDriveDownload size={16} />
                        </button>
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
                      )
                    )}
                  </div>
                </div>
              ) : (
                <div className="album-detail-actions compact-action-bar">
                  <div className="album-detail-actions-primary">
                    <button
                      className="btn btn-primary"
                      id="album-play-all-btn"
                      onClick={onPlayAll}
                      {...tooltipAttrs(t('albumDetail.playTooltip'))}
                    >
                      <Play size={15} /> <span className="compact-btn-label">{t('common.play', 'Reproducir')}</span>
                    </button>
                    {onShuffleAll && (
                      <button
                        className="btn btn-surface"
                        onClick={onShuffleAll}
                        data-tooltip={t('playlists.shuffle', 'Shuffle')}
                      >
                        <Shuffle size={16} />
                      </button>
                    )}
                    <button
                      className="btn btn-surface"
                      onClick={onEnqueueAll}
                      data-tooltip={t('albumDetail.enqueueTooltip')}
                    >
                      <ListPlus size={16} />
                    </button>
                    {policy.canFavorite && (
                      <button
                        className={`btn btn-surface${isStarred ? ' is-starred' : ''}`}
                        onClick={onToggleStar}
                        data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                      >
                        <Heart size={16} fill={isStarred ? 'currentColor' : 'none'} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-surface"
                      onClick={handleShareAlbum}
                      aria-label={t('albumDetail.shareAlbum')}
                      data-tooltip={t('albumDetail.shareAlbum')}
                    >
                      <Share2 size={16} />
                    </button>
                  </div>

                  {showBioButton && policy.canShowBio && (
                    <button
                      className="btn btn-surface"
                      id="album-bio-btn"
                      onClick={onBio}
                      {...tooltipAttrs(t('albumDetail.artistBioTooltip'))}
                    >
                      <Highlighter size={16} /> <span className="compact-btn-label">{t('albumDetail.artistBio')}</span>
                    </button>
                  )}

                  {policy.canDownload && (
                    downloadProgress !== null ? (
                      <div className="download-progress-wrap">
                        <Download size={14} />
                        <div className="download-progress-bar">
                          <div className="download-progress-fill" style={{ width: `${downloadProgress}%` }} />
                        </div>
                        <span className="download-progress-pct">{downloadProgress}%</span>
                      </div>
                    ) : (
                      <button
                        className="btn btn-surface"
                        id="album-download-btn"
                        onClick={onDownload}
                        {...tooltipAttrs(t('albumDetail.downloadTooltip'))}
                      >
                        <Download size={16} /> <span className="compact-btn-label">{t('albumDetail.download')}{totalSize > 0 ? ` · ${formatMb(totalSize)}` : ''}</span>
                      </button>
                    )
                  )}
                  {policy.canPinOffline && (
                    offlineStatus === 'downloading' && offlineProgress ? (
                      <div className="offline-cache-btn offline-cache-btn--progress">
                        <Loader2 size={14} className="spin" />
                        {t('albumDetail.offlineDownloading', { n: offlineProgress.done, total: offlineProgress.total })}
                      </div>
                    ) : offlineStatus === 'queued' ? (
                      <button
                        className="btn btn-surface offline-cache-btn offline-cache-btn--queued"
                        onClick={onCacheOffline}
                        aria-label={t('albumDetail.offlineQueued')}
                        data-tooltip={t('albumDetail.removeFromOfflineQueue')}
                      >
                        <HardDriveDownload size={16} />
                        <span className="compact-btn-label">{t('albumDetail.offlineQueued')}</span>
                      </button>
                    ) : offlineStatus === 'cached' ? (
                      <button
                        className="btn btn-surface offline-cache-btn offline-cache-btn--cached"
                        onClick={onRemoveOffline}
                        aria-label={t('albumDetail.offlineCached')}
                        data-tooltip={t('albumDetail.removeOffline')}
                      >
                        <HardDriveDownload size={16} />
                        <span className="compact-btn-label">{t('albumDetail.offlineCached')}</span>
                      </button>
                    ) : (
                      <button
                        className="btn btn-surface offline-cache-btn"
                        onClick={onCacheOffline}
                        aria-label={t('albumDetail.cacheOffline')}
                        data-tooltip={t('albumDetail.cacheOffline')}
                      >
                        <HardDriveDownload size={16} />
                        <span className="compact-btn-label">{t('albumDetail.cacheOffline')}</span>
                      </button>
                    )
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
