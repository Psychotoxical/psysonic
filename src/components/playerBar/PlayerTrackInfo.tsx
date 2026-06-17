import { Cast, Heart, Maximize2, Music } from 'lucide-react';
import type { TFunction } from 'i18next';
import { queueSongRating } from '../../store/pendingStarSync';
import type { InternetRadioStation, SubsonicOpenArtistRef } from '../../api/subsonicTypes';
import type { PlayerState, Track } from '../../store/playerStoreTypes';
import type { RadioMetadata } from '../../hooks/useRadioMetadata';
import type { PreviewingTrack } from '../../store/previewStore';
import { CoverArtImage } from '../../cover/CoverArtImage';
import { albumCoverRef } from '../../cover/ref';
import { useAlbumCoverRef } from '../../cover/useLibraryCoverRef';
import { usePlaybackTrackCoverRef } from '../../cover/useLibraryCoverRef';
import MarqueeText from '../MarqueeText';
import { OpenArtistRefInline } from '../OpenArtistRefInline';
import StarRating from '../StarRating';
import { PlaybackBufferingOverlay } from '../playback/PlaybackBufferingOverlay';
import { usePlayerStore } from '../../store/playerStore';
import { useEnrichmentPrimaryLabel } from '../../hooks/useEnrichmentPrimaryLabel';
import { useEnrichmentPrimaryIcon } from '../../hooks/useEnrichmentPrimaryIcon';
import { renderPresetIcon } from '../settings/musicNetwork/presetIcon';
import {
  usePlayerBarLayoutStore,
  type PlayerBarLayoutItemId,
} from '../../store/playerBarLayoutStore';
import { useOfflineBrowseContext } from '../../hooks/useOfflineBrowseContext';
import { offlineActionPolicy } from '../../utils/offline/offlineActionPolicy';

interface Props {
  currentTrack: Track | null;
  currentRadio: InternetRadioStation | null;
  isRadio: boolean;
  radioMeta: RadioMetadata;
  radioCoverArtId?: string;
  coverArtId?: string;
  displayTitle: string;
  displayArtist: string;
  /** When set (OpenSubsonic `artists` on the playing track), render split links like album track rows. */
  displayArtistRefs?: SubsonicOpenArtistRef[];
  showPreviewMeta: boolean;
  previewingTrack: PreviewingTrack | null;
  isStarred: boolean;
  toggleStar: () => void;
  enrichmentPrimaryId: string | null;
  networkLoved: boolean;
  toggleNetworkLove: () => void;
  userRatingOverrides: Record<string, number>;
  toggleFullscreen: () => void;
  navigate: (to: string) => void | Promise<void>;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

export function PlayerTrackInfo({
  currentTrack, currentRadio, isRadio, radioMeta, radioCoverArtId,
  coverArtId, displayTitle, displayArtist, displayArtistRefs,
  showPreviewMeta, previewingTrack, isStarred, toggleStar,
  enrichmentPrimaryId, networkLoved, toggleNetworkLove,
  userRatingOverrides, toggleFullscreen,
  navigate, openContextMenu, t,
}: Props) {
  const showBufferingOverlay = usePlayerStore(s => s.isPlaybackBuffering);
  const networkLabel = useEnrichmentPrimaryLabel() ?? '';
  const networkIcon = useEnrichmentPrimaryIcon();
  const playbackCoverRef = usePlaybackTrackCoverRef(
    showPreviewMeta ? null : currentTrack ?? undefined,
  );
  const previewCoverRef = useAlbumCoverRef(
    showPreviewMeta ? coverArtId : null,
    showPreviewMeta ? coverArtId : null,
    undefined,
    showPreviewMeta ? { libraryResolve: false } : undefined,
  );
  const activeCoverRef = showPreviewMeta ? previewCoverRef : playbackCoverRef;
  const layoutItems = usePlayerBarLayoutStore(s => s.items);
  const isLayoutVisible = (id: PlayerBarLayoutItemId) =>
    layoutItems.find(i => i.id === id)?.visible !== false;
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const playerPolicy = offlineActionPolicy('playerBar', offlineBrowseActive);

  return (
    <div className="player-track-info">
      <div
        className={`player-album-art-wrap${showBufferingOverlay && !isRadio && !showPreviewMeta ? ' playback-buffering' : ''}${currentTrack && !isRadio && !showPreviewMeta ? ' clickable' : ''}`}
        onClick={() => !isRadio && !showPreviewMeta && currentTrack && toggleFullscreen()}
        data-tooltip={!isRadio && !showPreviewMeta && currentTrack ? t('player.openFullscreen') : undefined}
      >
        {isRadio ? (
          radioCoverArtId && currentRadio ? (
            <CoverArtImage
              className="player-album-art"
              coverRef={albumCoverRef(radioCoverArtId, radioCoverArtId)}
              displayCssPx={128}
              surface="sparse"
              alt={currentRadio?.name ?? ''}
            />
          ) : (
            <div className="player-album-art-placeholder">
              <Cast size={20} />
            </div>
          )
        ) : !isRadio && activeCoverRef ? (
          <CoverArtImage
            className="player-album-art"
            coverRef={activeCoverRef}
            displayCssPx={128}
            surface="sparse"
            ensurePriority="high"
            alt={showPreviewMeta ? `${previewingTrack!.title} Cover` : `${currentTrack?.album ?? ''} Cover`}
          />
          ) : (
          <div className="player-album-art-placeholder">
            <Music size={22} />
          </div>
        )}
        {currentTrack && !isRadio && !showPreviewMeta && (
          <div className="player-art-expand-hint" aria-hidden="true">
            <Maximize2 size={16} />
          </div>
        )}
        {showBufferingOverlay && !isRadio && !showPreviewMeta && (
          <PlaybackBufferingOverlay />
        )}
      </div>
      <div className="player-track-meta">
        {showPreviewMeta && (
          <span className="player-preview-label" aria-label={t('player.previewActive')}>
            {t('player.previewLabel')}
          </span>
        )}
        <MarqueeText
          text={isRadio
            ? (radioMeta.currentTitle
                ? (radioMeta.currentArtist
                    ? `${radioMeta.currentArtist} — ${radioMeta.currentTitle}`
                    : radioMeta.currentTitle)
                : (currentRadio?.name ?? '—'))
            : displayTitle}
          className="player-track-name"
          style={{ cursor: !isRadio && !showPreviewMeta && currentTrack?.albumId ? 'pointer' : 'default' }}
          onClick={() => !isRadio && !showPreviewMeta && currentTrack?.albumId && navigate(`/album/${currentTrack.albumId}`)}
          onContextMenu={!isRadio && !showPreviewMeta && currentTrack
            ? (e) => {
                e.preventDefault();
                // The player bar represents the current song, so its menu is
                // song-scoped (e.g. "Add to playlist" adds this track, not the
                // whole album). pinToPlaybackServer: the track plays from the
                // playback server, which may differ from the active one.
                openContextMenu(e.clientX, e.clientY, currentTrack, 'song', undefined, undefined, undefined, undefined, true);
              }
            : undefined}
        />
        {!isRadio && displayArtistRefs && displayArtistRefs.length > 0 ? (
          <div className="marquee-wrap player-track-artist">
            <OpenArtistRefInline
              refs={displayArtistRefs}
              fallbackName={displayArtist}
              onGoArtist={id => navigate(`/artist/${id}`)}
              as="none"
              linkTag="span"
              linkClassName="player-artist-link"
            />
          </div>
        ) : (
          <MarqueeText
            text={isRadio
              ? (radioMeta.currentTitle && currentRadio?.name
                  ? currentRadio.name
                  : t('radio.liveStream'))
              : displayArtist}
            className="player-track-artist"
            style={{ cursor: !isRadio && !showPreviewMeta && currentTrack?.artistId ? 'pointer' : 'default' }}
            onClick={() => !isRadio && !showPreviewMeta && currentTrack?.artistId && navigate(`/artist/${currentTrack.artistId}`)}
          />
        )}
        {currentTrack && !isRadio && !showPreviewMeta && isLayoutVisible('starRating') && playerPolicy.canRate && (
          <StarRating
            value={userRatingOverrides[currentTrack.id] ?? currentTrack.userRating ?? 0}
            onChange={r => queueSongRating(currentTrack.id, r)}
            className="player-track-rating"
            ariaLabel={t('albumDetail.ratingLabel')}
          />
        )}
        {isRadio && radioMeta.listeners != null && (
          <span className="player-radio-listeners">
            {t('radio.listenerCount', { count: radioMeta.listeners })}
          </span>
        )}
      </div>
      {currentTrack && !isRadio && isLayoutVisible('favorite') && playerPolicy.canFavorite && (
        <button
          className={`player-btn player-btn-sm player-star-btn${isStarred ? ' is-starred' : ''}`}
          onClick={toggleStar}
          aria-label={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
          data-tooltip={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
          style={{ flexShrink: 0 }}
        >
          <Heart size={15} fill={isStarred ? 'currentColor' : 'none'} />
        </button>
      )}
      {currentTrack && !isRadio && enrichmentPrimaryId !== null && isLayoutVisible('lastfmLove') && (
        <button
          className="player-btn player-btn-sm player-love-btn"
          onClick={toggleNetworkLove}
          aria-label={networkLoved ? t('contextMenu.networkUnlove', { provider: networkLabel }) : t('contextMenu.networkLove', { provider: networkLabel })}
          data-tooltip={networkLoved ? t('contextMenu.networkUnlove', { provider: networkLabel }) : t('contextMenu.networkLove', { provider: networkLabel })}
          style={{ color: networkLoved ? '#e31c23' : 'var(--text-muted)', flexShrink: 0 }}
        >
          {renderPresetIcon(networkIcon ?? 'lastfm', 15)}
        </button>
      )}
    </div>
  );
}
