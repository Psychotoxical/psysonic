import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import React, { memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNavigateToAlbum } from '@/features/album/hooks/useNavigateToAlbum';
import { Play, ListPlus, HardDriveDownload, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { isOfflinePinComplete } from '@/features/offline';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import { coverStorageKeyFromRef } from '@/cover/storageKeys';
import type { CoverPrefetchPriority } from '@/cover/types';
import { COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '@/cover/layoutSizes';
import { resolveCoverDisplayTier } from '@/cover/tiers';
import { acquireUrl } from '@/cover';
import { OpenArtistRefInline } from '@/ui/OpenArtistRefInline';
import { fetchAlbumTracks, playAlbum, playAlbumShuffled } from '@/features/playback/utils/playback/playAlbum';
import { useLongPressAction } from '@/lib/hooks/useLongPressAction';
import { LongPressWaveOverlay } from '@/ui/LongPressWaveOverlay';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { isAlbumRecentlyAdded } from '@/features/album/utils/albumRecency';
import { albumArtistDisplayName, deriveAlbumArtistRefs } from '@/features/album/utils/deriveAlbumHeaderArtistRefs';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import { appendServerQuery } from '@/lib/navigation/detailServerScope';

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
  const { isHolding, pressBind } = useLongPressAction({
    onShortPress: () => playAlbum(album.id, album.serverId ? { serverId: album.serverId } : undefined),
    onLongPress: () => playAlbumShuffled(album.id, album.serverId ? { serverId: album.serverId } : undefined),
  });
  const navigate = useNavigate();
  const navigateToAlbum = useNavigateToAlbum();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);
  const activeServerId = useAuthStore(s => s.activeServerId ?? '');
  const offlineServerId = album.serverId ?? activeServerId;
  const localEntries = useLocalPlaybackStore(s => s.entries);
  const isOffline = isOfflinePinComplete(album.id, offlineServerId);
  const albumLinkQuery = useMemo(
    () => appendServerQuery(linkQuery, album.serverId),
    [linkQuery, album.serverId],
  );
  void localEntries;
  const psyDrag = useDragDrop();
  const coverServerScope = useMemo(
    () => coverServerScopeForServerId(album.serverId),
    [album.serverId],
  );
  const coverRef = useAlbumCoverRef(album.id, album.coverArt, coverServerScope, { libraryResolve });
  const dragCoverKey = useMemo(() => {
    if (!coverRef) return '';
    const tier = resolveCoverDisplayTier(displayCssPx, { surface: 'dense' });
    return coverStorageKeyFromRef(coverRef, tier);
  }, [coverRef, displayCssPx]);
  const isNewAlbum = isAlbumRecentlyAdded(album.created);
  const artistRefs = useMemo(() => deriveAlbumArtistRefs(album), [album]);
  const artistLabel = useMemo(() => albumArtistDisplayName(album), [album]);

  const handleClick = (opts?: { shiftKey?: boolean }) => {
    if (selectionMode) { onToggleSelect?.(album.id, opts); return; }
    navigateToAlbum(album.id, { search: albumLinkQuery });
  };

  return (
    <div
      className={`album-card card${selectionMode ? ' album-card--selectable' : ''}${selected ? ' album-card--selected' : ''}`}
      onClick={e => handleClick({ shiftKey: e.shiftKey })}
      role="button"
      tabIndex={0}
      aria-label={`${album.name} von ${artistLabel}`}
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
              <button
                className="album-card-details-btn long-press-play-btn"
                {...pressBind}
                aria-label={`${t('hero.playAlbumTooltip')} — ${album.name}`}
                data-tooltip={t('hero.playAlbumTooltip')}
                data-tooltip-pos="top"
              >
                <LongPressWaveOverlay active={isHolding} />
                <span className="long-press-play-btn__icon">
                  <Play size={15} fill="currentColor" />
                </span>
              </button>
            <button
              className="album-card-details-btn"
              onClick={async e => {
                e.stopPropagation();
                try {
                  const tracks = await fetchAlbumTracks(
                    album.id,
                    offlineServerId || undefined,
                  );
                  if (tracks.length > 0) enqueue(tracks);
                } catch {
                  // Unavailable offline or network failure — silent on hover action
                }
              }}
              aria-label={t('contextMenu.enqueueAlbum')}
              data-tooltip={t('contextMenu.enqueueAlbum')}
              data-tooltip-pos="top"
            >
              <ListPlus size={15} />
            </button>
          </div>
        )}
      </div>
      <div className="album-card-info">
        <p className="album-card-title truncate">{album.name}</p>
        <p className="album-card-artist truncate">
          <OpenArtistRefInline
            refs={artistRefs}
            fallbackName={artistLabel}
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
