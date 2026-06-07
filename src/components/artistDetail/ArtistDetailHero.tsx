import React, { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlbumDetailBack } from '../../hooks/useAlbumDetailBack';
import {
  ArrowLeft, Camera, Check, ExternalLink, HardDriveDownload, Heart,
  Loader2, Play, Radio, Share2, Shuffle, Users,
} from 'lucide-react';
import type { SubsonicAlbum, SubsonicArtist, SubsonicArtistInfo } from '../../api/subsonicTypes';
import { useOfflineStore } from '../../store/offlineStore';
import { useAuthStore } from '../../store/authStore';
import { useArtistOfflineState } from '../../hooks/useArtistOfflineState';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ArtistHeroCover } from '../../cover/artistHero';
import { useCoverLightboxSrc } from '../../cover/lightbox';
import type { CoverArtRef } from '../../cover/types';
import LastfmIcon from '../LastfmIcon';
import StarRating from '../StarRating';
import { tooltipAttrs } from '../tooltipAttrs';
import { offlineActionPolicy, type OfflineActionPolicy } from '../../utils/offline/offlineActionPolicy';

interface Props {
  artist: SubsonicArtist;
  id: string | undefined;
  albums: SubsonicAlbum[];
  info: SubsonicArtistInfo | null;
  isStarred: boolean;
  artistEntityRating: number;
  handleArtistEntityRating: (rating: number) => Promise<void>;
  toggleStar: () => Promise<void>;
  handlePlayAll: () => void;
  handleShuffle: () => void;
  handleStartRadio: () => void;
  handleShareArtist: () => void;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  playAllLoading: boolean;
  radioLoading: boolean;
  uploading: boolean;
  openedLink: string | null;
  openLink: (url: string, key: string) => void;
  coverId: string;
  coverRef: CoverArtRef | null;
  coverRevision: number;
  headerCoverFailed: boolean;
  setHeaderCoverFailed: React.Dispatch<React.SetStateAction<boolean>>;
  actionPolicy?: OfflineActionPolicy;
}

export default function ArtistDetailHero({
  artist, id, albums, info, isStarred, artistEntityRating, handleArtistEntityRating,
  toggleStar, handlePlayAll, handleShuffle, handleStartRadio, handleShareArtist,
  handleImageUpload, playAllLoading, radioLoading, uploading,
  openedLink, openLink,
  coverId, coverRef, coverRevision, headerCoverFailed, setHeaderCoverFailed,
  actionPolicy,
}: Props) {
  const policy = actionPolicy ?? offlineActionPolicy('artistDetail', false);
  const { t } = useTranslation();
  const goBack = useAlbumDetailBack();
  const isMobile = useIsMobile();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const downloadArtist = useOfflineStore(s => s.downloadArtist);
  const activeServerId = useAuthStore(s => s.activeServerId) ?? '';
  const artistAlbumIds = useMemo(() => albums.map(a => a.id), [albums]);
  const { status: artistOfflineStatus, progress: artistOfflineProgress } = useArtistOfflineState(
    id ?? '',
    activeServerId,
    artistAlbumIds,
  );
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const artistEntityRatingSupport = entityRatingSupportByServer[activeServerId] ?? 'unknown';

  const { open: openLightbox, lightbox } = useCoverLightboxSrc(coverRef, { alt: artist.name });

  const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(artist.name)}`;

  return (
    <>
      <button
        className="btn btn-ghost"
        onClick={() => goBack()}
        style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        <ArrowLeft size={16} /> <span>{t('artistDetail.back')}</span>
      </button>

      {lightbox}

      <div className="artist-detail-header">
        <div className="artist-detail-avatar" style={{ position: 'relative' }}>
          {coverId ? (
            <button
              className="artist-detail-avatar-btn"
              onClick={openLightbox}
              aria-label={`${artist.name} Bild vergrößern`}
            >
              {!headerCoverFailed ? (
                <ArtistHeroCover
                  key={coverRevision}
                  artistId={id ?? artist.id}
                  artistInfo={info}
                  coverFallback={coverRef}
                  displayCssPx={300}
                  surface="sparse"
                  alt={artist.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={() => setHeaderCoverFailed(true)}
                />
              ) : (
                <Users size={64} color="var(--text-muted)" style={{ margin: 'auto', display: 'block' }} />
              )}
            </button>
          ) : (
            <Users size={64} color="var(--text-muted)" />
          )}
          {/* Upload overlay */}
          <div
            className="artist-avatar-upload-overlay"
            onClick={e => { e.stopPropagation(); imageInputRef.current?.click(); }}
          >
            {uploading
              ? <Loader2 size={22} className="spin-slow" />
              : <Camera size={22} />}
          </div>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleImageUpload}
          />
        </div>

        <div className="artist-detail-meta">
          <h1 className="page-title" style={{ fontSize: '3rem', marginBottom: '0.25rem' }}>
            {artist.name}
          </h1>
          <div style={{ color: 'var(--text-secondary)', fontSize: '1rem', marginBottom: '1rem' }}>
            {t('artistDetail.albumCount_other', { count: artist.albumCount ?? 0 })}
          </div>

          <div className="artist-detail-entity-rating">
            <span className="artist-detail-entity-rating-label">{t('entityRating.artistShort')}</span>
            <StarRating
              value={artistEntityRating}
              onChange={handleArtistEntityRating}
              disabled={!policy.canRate || artistEntityRatingSupport === 'track_only'}
              labelKey="entityRating.artistAriaLabel"
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(info?.lastFmUrl || artist.name) && (
              <div className="artist-detail-links">
                {info?.lastFmUrl && (
                  <button
                    className="artist-ext-link"
                    onClick={() => openLink(info.lastFmUrl!, 'lastfm')}
                    {...tooltipAttrs(t('artistDetail.lastfmTooltip'))}
                  >
                    <LastfmIcon size={14} />
                    {openedLink === 'lastfm' ? t('artistDetail.openedInBrowser') : 'Last.fm'}
                  </button>
                )}
                <button
                  className="artist-ext-link"
                  onClick={() => openLink(wikiUrl, 'wiki')}
                  {...tooltipAttrs(t('artistDetail.wikipediaTooltip'))}
                >
                  <ExternalLink size={14} />
                  {openedLink === 'wiki' ? t('artistDetail.openedInBrowser') : 'Wikipedia'}
                </button>
              </div>
            )}

            {policy.canFavorite && (
              <button
                className="artist-ext-link"
                onClick={toggleStar}
                data-tooltip={isStarred ? t('artistDetail.favoriteRemove') : t('artistDetail.favoriteAdd')}
                style={{ color: isStarred ? 'var(--accent)' : 'inherit', border: isStarred ? '1px solid var(--accent)' : undefined }}
              >
                <Heart size={14} fill={isStarred ? "currentColor" : "none"} />
                {t('artistDetail.favorite')}
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '1.5rem', flexWrap: 'wrap' }}>
            {albums.length > 0 && (
              <>
                <button
                  className="btn btn-primary"
                  onClick={handlePlayAll}
                  disabled={playAllLoading}
                  {...tooltipAttrs(t('artistDetail.playAllTooltip'))}
                >
                  {playAllLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Play size={16} />}
                  {t('artistDetail.playAll')}
                </button>
                <button
                  className="btn btn-surface"
                  onClick={handleShuffle}
                  disabled={playAllLoading}
                  {...tooltipAttrs(t('artistDetail.shuffleTooltip'))}
                >
                  {playAllLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Shuffle size={16} />}
                  {!isMobile && t('artistDetail.shuffle')}
                </button>
              </>
            )}
            <button
              className="btn btn-surface"
              onClick={handleStartRadio}
              disabled={radioLoading}
              {...tooltipAttrs(t('artistDetail.radioTooltip'))}
            >
              {radioLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Radio size={16} />}
              {!isMobile && (radioLoading ? t('artistDetail.loading') : t('artistDetail.radio'))}
            </button>
            {id && artist && (
              <button
                type="button"
                className="btn btn-surface"
                onClick={handleShareArtist}
                aria-label={t('artistDetail.shareArtist')}
                data-tooltip={t('artistDetail.shareArtist')}
              >
                <Share2 size={16} />
              </button>
            )}
            {policy.canCacheDiscography && albums.length > 0 && (
              <button
                className="btn btn-surface"
                disabled={
                  artistOfflineStatus === 'downloading'
                  || artistOfflineStatus === 'queued'
                  || artistOfflineStatus === 'cached'
                }
                onClick={() => {
                  if (id && artist && artistOfflineStatus !== 'cached') {
                    downloadArtist(id, artist.name, activeServerId);
                  }
                }}
                data-tooltip={
                  artistOfflineStatus === 'downloading' && artistOfflineProgress
                    ? t('artistDetail.offlineDownloading', {
                      done: artistOfflineProgress.done,
                      total: artistOfflineProgress.total,
                    })
                    : artistOfflineStatus === 'queued'
                      ? t('artistDetail.offlineQueued')
                      : artistOfflineStatus === 'cached'
                        ? t('artistDetail.offlineCached')
                        : t('artistDetail.cacheOffline')
                }
              >
                {artistOfflineStatus === 'downloading'
                  ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
                  : artistOfflineStatus === 'cached'
                    ? <Check size={16} />
                    : <HardDriveDownload size={16} />}
                {!isMobile && (
                  artistOfflineStatus === 'downloading' && artistOfflineProgress
                    ? t('artistDetail.offlineDownloading', {
                      done: artistOfflineProgress.done,
                      total: artistOfflineProgress.total,
                    })
                    : artistOfflineStatus === 'queued'
                      ? t('artistDetail.offlineQueued')
                      : artistOfflineStatus === 'cached'
                        ? t('artistDetail.offlineCached')
                        : t('artistDetail.cacheOffline')
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
