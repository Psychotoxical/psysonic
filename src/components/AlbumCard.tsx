import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import React, { memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus, HardDriveDownload, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../store/playerStore';
import { useOfflineStore } from '../store/offlineStore';
import { useAuthStore } from '../store/authStore';
import { CoverArtImage } from '../cover/CoverArtImage';
import { useAlbumCoverRef } from '../cover/useLibraryCoverRef';
import { coverStorageKeyFromRef } from '../cover/storageKeys';
import type { CoverPrefetchPriority } from '../cover/types';
import { COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '../cover/layoutSizes';
import { resolveCoverDisplayTier } from '../cover/tiers';
import { acquireUrl } from '../utils/imageCache/urlPool';
import { OpenArtistRefInline } from './OpenArtistRefInline';
import { playAlbum, playAlbumShuffled } from '../utils/playback/playAlbum';
import { useDragDrop } from '../contexts/DragDropContext';
import { isAlbumRecentlyAdded } from '../utils/albumRecency';
import { deriveAlbumArtistRefs } from '../utils/album/deriveAlbumHeaderArtistRefs';

interface AlbumCardProps {
  album: SubsonicAlbum;
  selected?: boolean;
  selectionMode?: boolean;
  onToggleSelect?: (id: string, opts?: { shiftKey?: boolean }) => void;
  showRating?: boolean;
  selectedAlbums?: SubsonicAlbum[];
  disableArtwork?: boolean;
  /** Layout-native cover square width in CSS px (from parent grid). */
  displayCssPx?: number;
  /** @deprecated Use displayCssPx — kept for call-site transition only */
  artworkSize?: number;
  /** Appended to `/album/:id`, e.g. `lossless=1`. */
  linkQuery?: string;
  /** In-page scroll viewport (`VirtualCardGrid` `scrollRootId`) for cover IO priority. */
  observeScrollRootId?: string;
  /** `high` for bounded grids (Random Albums, …) — skip defer-until-visible. */
  ensurePriority?: CoverPrefetchPriority;
  /** Artist/detail grids: API `coverArt` is enough — skip per-card library_resolve IPC. */
  libraryResolve?: boolean;
}

function AlbumCard({
  album,
  selected,
  selectionMode,
  onToggleSelect,
  showRating = false,
  selectedAlbums = [],
  disableArtwork = false,
  displayCssPx = COVER_DENSE_GRID_MIN_CELL_CSS_PX,
  artworkSize: _artworkSize,
  observeScrollRootId,
  ensurePriority,
  linkQuery,
  libraryResolve = false,
}: AlbumCardProps) {
  const { t } = useTranslation();
  const longPressTriggered = React.useRef(false);
  const [isHolding, setIsHolding] = React.useState(false);
  const [ripplePos, setRipplePos] = React.useState({ x: 0, y: 0 });
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const isOffline = useOfflineStore(s => {
    const meta = s.albums[`${serverId}:${album.id}`];
    if (!meta || meta.trackIds.length === 0) return false;
    return meta.trackIds.every(tid => !!s.tracks[`${serverId}:${tid}`]);
  });
  const psyDrag = useDragDrop();
  const coverRef = useAlbumCoverRef(album.id, album.coverArt, undefined, { libraryResolve });
  const dragCoverKey = useMemo(() => {
    if (!coverRef) return '';
    const tier = resolveCoverDisplayTier(displayCssPx, { surface: 'dense' });
    return coverStorageKeyFromRef(coverRef, tier);
  }, [coverRef, displayCssPx]);
  const isNewAlbum = isAlbumRecentlyAdded(album.created);
  const artistRefs = useMemo(() => deriveAlbumArtistRefs(album), [album]);

  const handleClick = (opts?: { shiftKey?: boolean }) => {
    if (selectionMode) { onToggleSelect?.(album.id, opts); return; }
    navigate(linkQuery ? `/album/${album.id}?${linkQuery}` : `/album/${album.id}`);
  };

  return (
    <div
      className={`album-card card${selectionMode ? ' album-card--selectable' : ''}${selected ? ' album-card--selected' : ''}`}
      onClick={e => handleClick({ shiftKey: e.shiftKey })}
      role="button"
      tabIndex={0}
      aria-label={`${album.name} von ${album.artist}`}
      onKeyDown={e => e.key === 'Enter' && handleClick()}
      onContextMenu={(e) => {
        e.preventDefault();
        if (selectionMode && selectedAlbums.length > 0) {
          openContextMenu(e.clientX, e.clientY, selectedAlbums, 'multi-album');
        } else {
          openContextMenu(e.clientX, e.clientY, album, 'album');
        }
      }}
      onMouseDown={e => {
        if (selectionMode || e.button !== 0) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const coverUrl = dragCoverKey ? acquireUrl(dragCoverKey) ?? undefined : undefined;
            psyDrag.startDrag({ data: JSON.stringify({ type: 'album', id: album.id, name: album.name }), label: album.name, coverUrl }, me.clientX, me.clientY);
          }
        };
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    >
      <div className="album-card-cover">
        {!disableArtwork && coverRef ? (
          <CoverArtImage
            coverRef={coverRef}
            displayCssPx={displayCssPx}
            surface="dense"
            alt={`${album.name} Cover`}
            loading="eager"
            decoding="async"
            observeScrollRootId={observeScrollRootId}
            ensurePriority={ensurePriority}
          />
        ) : (
          <div className="album-card-cover-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
        )}
        {(isNewAlbum || (isOffline && !selectionMode)) && (
          <div className="album-card-cover-badges-tr">
            {isNewAlbum && (
              <div className="album-card-new-badge" aria-label={t('common.new', 'New')}>
                {t('common.new', 'New')}
              </div>
            )}
            {isOffline && !selectionMode && (
              <div className="album-card-offline-badge" aria-label="Offline available">
                <HardDriveDownload size={12} />
              </div>
            )}
          </div>
        )}
        {selectionMode && (
          <div className={`album-card-select-check${selected ? ' album-card-select-check--on' : ''}`}>
            {selected && <Check size={14} strokeWidth={3} />}
          </div>
        )}
        {!selectionMode && (
          <div className="album-card-play-overlay">
            <>
              <style>{`
                @keyframes slosh {
                   0% { transform: translateX(0); }
                   100% { transform: translateX(-50%); }
               }
             `}</style>
              <button
                className="album-card-details-btn"
                style={{ position: 'relative', overflow: 'hidden' }}
                onClick={e => {
                  e.stopPropagation()
                  if (longPressTriggered.current) {
                    longPressTriggered.current = false
                    return
                  }
                  playAlbum(album.id)
                }}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  longPressTriggered.current = false

                  const animTimer = setTimeout(() => {
                    setIsHolding(true)
                  }, 100)

                  const timer = setTimeout(() => {
                    longPressTriggered.current = true
                    playAlbumShuffled(album.id)
                    setIsHolding(false)
                  }, 1000)

                  const clear = () => {
                    clearTimeout(timer)
                    clearTimeout(animTimer)
                    setIsHolding(false)
                  }
                  document.addEventListener('mouseup', clear, { once: true })
                  document.addEventListener('mouseleave', clear, { once: true })
                }}
                aria-label={`${album.name} abspielen`}
                data-tooltip={t('hero.playAlbumTooltip')}
                data-tooltip-pos="top"
              >
                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    color: 'currentColor',
                    opacity: isHolding ? 0.25 : 0,
                    transform: isHolding ? 'translateY(0)' : 'translateY(calc(100% + 15px))',
                    transition: isHolding ? 'transform 900ms linear' : 'none',
                    pointerEvents: 'none',
                    zIndex: 0
                  }}
                >
                  <svg
                    viewBox="0 0 200 20"
                    preserveAspectRatio="none"
                    style={{
                      position: 'absolute',
                      top: '-10px',
                      left: 0,
                      width: '200%',
                      height: '12px',
                      animation: isHolding ? 'slosh 1.2s linear infinite' : 'none'
                    }}
                  >
                    <path d="M0,10 Q25,18 50,10 T100,10 Q125,18 150,10 T200,10 L200,20 L0,20 Z" fill="currentColor" />
                  </svg>
                  <div style={{ position: 'absolute', top: '2px', left: 0, width: '100%', height: '100%', backgroundColor: 'currentColor' }} />
                </div>

                <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex' }}>
                  <Play size={15} fill="currentColor" />
                </span>
              </button>
            <button
              className="album-card-details-btn"
              onClick={async e => {
                e.stopPropagation();
                try {
                  const data = await getAlbum(album.id);
                  enqueue(data.songs.map(songToTrack));
                } catch {
                  // Network failure — silent (toast would be too noisy for a hover action)
                }
              }}
              aria-label={t('contextMenu.enqueueAlbum')}
              data-tooltip={t('contextMenu.enqueueAlbum')}
              data-tooltip-pos="top"
            >
              <ListPlus size={15} />
            </button> 
            </>
          </div>
        )}
      </div>
      <div className="album-card-info">
        <p className="album-card-title truncate">{album.name}</p>
        <p className="album-card-artist truncate">
          <OpenArtistRefInline
            refs={artistRefs}
            fallbackName={album.artist}
            onGoArtist={id => navigate(`/artist/${id}`)}
            as="none"
            linkTag="span"
            linkClassName="track-artist-link"
          />
        </p>
        {album.year && <p className="album-card-year">{album.year}</p>}
        {showRating && (album.userRating ?? 0) > 0 && (
          <div className="album-card-rating-row">
            <span className="album-card-rating-stars">
              {'★'.repeat(album.userRating!)}{'☆'.repeat(5 - album.userRating!)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AlbumCard);
