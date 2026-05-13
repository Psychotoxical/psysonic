import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Camera, Check, ExternalLink, HardDriveDownload, Heart,
  Loader2, Play, Radio, Share2, Shuffle, Users,
} from 'lucide-react';
import type { SubsonicAlbum, SubsonicArtist, SubsonicArtistInfo } from '../../api/subsonicTypes';
import { useOfflineStore } from '../../store/offlineStore';
import { useOfflineJobStore } from '../../store/offlineJobStore';
import { useAuthStore } from '../../store/authStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { extractCoverColors } from '../../utils/dynamicColors';
import CachedImage from '../CachedImage';
import CoverLightbox from '../CoverLightbox';
import LastfmIcon from '../LastfmIcon';
import StarRating from '../StarRating';

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
  artistCover300Src: string;
  artistCover300Key: string;
  artistCover2000Src: string;
  coverRevision: number;
  headerCoverFailed: boolean;
  setHeaderCoverFailed: React.Dispatch<React.SetStateAction<boolean>>;
  avatarGlow: string;
  setAvatarGlow: React.Dispatch<React.SetStateAction<string>>;
  lightboxOpen: boolean;
  setLightboxOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function ArtistDetailHero({
  artist, id, albums, info, isStarred, artistEntityRating, handleArtistEntityRating,
  toggleStar, handlePlayAll, handleShuffle, handleStartRadio, handleShareArtist,
  handleImageUpload, playAllLoading, radioLoading, uploading,
  openedLink, openLink,
  coverId, artistCover300Src, artistCover300Key, artistCover2000Src,
  coverRevision, headerCoverFailed, setHeaderCoverFailed,
  avatarGlow, setAvatarGlow, lightboxOpen, setLightboxOpen,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const downloadArtist = useOfflineStore(s => s.downloadArtist);
  const bulkProgress = useOfflineJobStore(s => s.bulkProgress);
  const activeServerId = useAuthStore(s => s.activeServerId) ?? '';
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const artistEntityRatingSupport = entityRatingSupportByServer[activeServerId] ?? 'unknown';

  const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(artist.name)}`;

  return (
    <>
      <button
        className="btn btn-ghost"
        onClick={() => navigate(-1)}
        style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        <ArrowLeft size={16} /> <span>{t('artistDetail.back')}</span>
      </button>

      {lightboxOpen && (
        <CoverLightbox
          src={artistCover2000Src}
          alt={artist.name}
          onClose={() => setLightboxOpen(false)}
        />
      )}

      <div className="artist-detail-header">
        <div
          className="artist-detail-avatar"
          style={{
            position: 'relative',
            boxShadow: avatarGlow ? `0 0 36px 8px ${avatarGlow.replace('rgb(', 'rgba(').replace(')', ', 0.55)')}` : undefined,
            transition: 'box-shadow 0.6s ease',
          }}
        >
          {coverId ? (
            <button
              className="artist-detail-avatar-btn"
              onClick={() => setLightboxOpen(true)}
              aria-label={`${artist.name} Bild vergrößern`}
            >
              {!headerCoverFailed ? (
                <CachedImage
                  key={coverRevision}
                  src={artistCover300Src}
                  cacheKey={artistCover300Key}
                  alt={artist.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onLoad={e => extractCoverColors(e.currentTarget.src).then(({ accent }) => { if (accent) setAvatarGlow(accent); })}
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
              disabled={artistEntityRatingSupport === 'track_only'}
              labelKey="entityRating.artistAriaLabel"
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(info?.lastFmUrl || artist.name) && (
              <div className="artist-detail-links">
                {info?.lastFmUrl && (
                  <button className="artist-ext-link" onClick={() => openLink(info.lastFmUrl!, 'lastfm')}>
                    <LastfmIcon size={14} />
                    {openedLink === 'lastfm' ? t('artistDetail.openedInBrowser') : 'Last.fm'}
                  </button>
                )}
                <button className="artist-ext-link" onClick={() => openLink(wikiUrl, 'wiki')}>
                  <ExternalLink size={14} />
                  {openedLink === 'wiki' ? t('artistDetail.openedInBrowser') : 'Wikipedia'}
                </button>
              </div>
            )}

            <button
              className="artist-ext-link"
              onClick={toggleStar}
              data-tooltip={isStarred ? t('artistDetail.favoriteRemove') : t('artistDetail.favoriteAdd')}
              style={{ color: isStarred ? 'var(--accent)' : 'inherit', border: isStarred ? '1px solid var(--accent)' : undefined }}
            >
              <Heart size={14} fill={isStarred ? "currentColor" : "none"} />
              {t('artistDetail.favorite')}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '1.5rem', flexWrap: 'wrap' }}>
            {albums.length > 0 && (
              <>
                <button className="btn btn-primary" onClick={handlePlayAll} disabled={playAllLoading}>
                  {playAllLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Play size={16} />}
                  {t('artistDetail.playAll')}
                </button>
                <button
                  className="btn btn-surface"
                  onClick={handleShuffle}
                  disabled={playAllLoading}
                  data-tooltip={isMobile ? t('artistDetail.shuffle') : undefined}
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
              data-tooltip={isMobile ? t('artistDetail.radio') : undefined}
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
            {albums.length > 0 && (() => {
              const progress = id ? bulkProgress[id] : undefined;
              const isDone = progress && progress.done === progress.total;
              const isDownloading = progress && !isDone;
              return (
                <button
                  className="btn btn-surface"
                  disabled={!!isDownloading}
                  onClick={() => { if (id && artist) downloadArtist(id, artist.name, activeServerId); }}
                  data-tooltip={isDownloading
                    ? t('artistDetail.offlineDownloading', { done: progress.done, total: progress.total })
                    : isDone ? t('artistDetail.offlineCached') : t('artistDetail.cacheOffline')}
                >
                  {isDownloading
                    ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
                    : isDone ? <Check size={16} /> : <HardDriveDownload size={16} />}
                  {!isMobile && (isDownloading
                    ? t('artistDetail.offlineDownloading', { done: progress.done, total: progress.total })
                    : isDone ? t('artistDetail.offlineCached') : t('artistDetail.cacheOffline'))}
                </button>
              );
            })()}
          </div>
        </div>
      </div>
    </>
  );
}
