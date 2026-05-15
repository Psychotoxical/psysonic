import { Cast, Heart, Maximize2, Music } from 'lucide-react';
import type { TFunction } from 'i18next';
import { setRating } from '../../api/subsonicStarRating';
import type { InternetRadioStation, SubsonicAlbum, SubsonicOpenArtistRef } from '../../api/subsonicTypes';
import type { PlayerState, Track } from '../../store/playerStoreTypes';
import type { RadioMetadata } from '../../hooks/useRadioMetadata';
import type { PreviewingTrack } from '../../store/previewStore';
import CachedImage from '../CachedImage';
import LastfmIcon from '../LastfmIcon';
import MarqueeText from '../MarqueeText';
import { OpenArtistRefInline } from '../OpenArtistRefInline';
import StarRating from '../StarRating';

interface Props {
  currentTrack: Track | null;
  currentRadio: InternetRadioStation | null;
  isRadio: boolean;
  radioMeta: RadioMetadata;
  radioCoverSrc: string;
  radioCoverKey: string;
  coverSrc: string;
  coverKey: string;
  displayCoverArt: string | undefined;
  displayTitle: string;
  displayArtist: string;
  /** When set (OpenSubsonic `artists` on the playing track), render split links like album track rows. */
  displayArtistRefs?: SubsonicOpenArtistRef[];
  showPreviewMeta: boolean;
  previewingTrack: PreviewingTrack | null;
  isStarred: boolean;
  toggleStar: () => void;
  lastfmSessionKey: string | null;
  lastfmLoved: boolean;
  toggleLastfmLove: () => void;
  userRatingOverrides: Record<string, number>;
  setUserRatingOverride: (id: string, r: number) => void;
  toggleFullscreen: () => void;
  navigate: (to: string) => void | Promise<void>;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

export function PlayerTrackInfo({
  currentTrack, currentRadio, isRadio, radioMeta, radioCoverSrc, radioCoverKey,
  coverSrc, coverKey, displayCoverArt, displayTitle, displayArtist, displayArtistRefs,
  showPreviewMeta, previewingTrack, isStarred, toggleStar,
  lastfmSessionKey, lastfmLoved, toggleLastfmLove,
  userRatingOverrides, setUserRatingOverride, toggleFullscreen,
  navigate, openContextMenu, t,
}: Props) {
  return (
    <div className="player-track-info">
      <div
        className={`player-album-art-wrap ${currentTrack && !isRadio && !showPreviewMeta ? 'clickable' : ''}`}
        onClick={() => !isRadio && !showPreviewMeta && currentTrack && toggleFullscreen()}
        data-tooltip={!isRadio && !showPreviewMeta && currentTrack ? t('player.openFullscreen') : undefined}
      >
        {isRadio ? (
          currentRadio?.coverArt ? (
            <CachedImage
              className="player-album-art"
              src={radioCoverSrc}
              cacheKey={radioCoverKey}
              alt={currentRadio.name}
            />
          ) : (
            <div className="player-album-art-placeholder">
              <Cast size={20} />
            </div>
          )
        ) : displayCoverArt ? (
          <CachedImage
            className="player-album-art"
            src={coverSrc}
            cacheKey={coverKey}
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
          onContextMenu={!isRadio && !showPreviewMeta && currentTrack?.albumId
            ? (e) => {
                e.preventDefault();
                const album: SubsonicAlbum = {
                  id: currentTrack.albumId!,
                  name: currentTrack.album,
                  artist: currentTrack.artist,
                  artistId: currentTrack.artistId ?? '',
                  coverArt: currentTrack.coverArt,
                  songCount: 0,
                  duration: 0,
                };
                openContextMenu(e.clientX, e.clientY, album, 'album', undefined, undefined, undefined, undefined, true);
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
        {currentTrack && !isRadio && !showPreviewMeta && (
          <StarRating
            value={userRatingOverrides[currentTrack.id] ?? currentTrack.userRating ?? 0}
            onChange={r => { setUserRatingOverride(currentTrack.id, r); setRating(currentTrack.id, r).catch(() => {}); }}
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
      {currentTrack && !isRadio && (
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
      {currentTrack && !isRadio && lastfmSessionKey && (
        <button
          className="player-btn player-btn-sm player-love-btn"
          onClick={toggleLastfmLove}
          aria-label={lastfmLoved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
          data-tooltip={lastfmLoved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
          style={{ color: lastfmLoved ? '#e31c23' : 'var(--text-muted)', flexShrink: 0 }}
        >
          <LastfmIcon size={15} />
        </button>
      )}
    </div>
  );
}
