import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlbumDetailBack } from '@/features/album';
import {
  ArrowLeft, Camera, Check, HardDriveDownload, Heart,
  Loader2, Play, Radio, Share2, Shuffle, Users,
} from 'lucide-react';
import type { SubsonicAlbum, SubsonicArtist, SubsonicArtistInfo } from '@/lib/api/subsonicTypes';
import { useOfflineStore } from '@/features/offline';
import { useAuthStore } from '@/store/authStore';
import { useThemeStore } from '@/store/themeStore';
import { useArtistOfflineState } from '@/features/artist/hooks/useArtistOfflineState';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { ArtistHeroCover } from '@/cover/artistHero';
import { useArtistBanner, useArtistFanart } from '@/cover/useArtistFanart';
import { backdropFromConfig } from '@/cover/artistBackdrop';
import { usePlaybackCoverArt } from '@/cover/usePlaybackCoverArt';
import { useCachedUrl } from '@/ui/CachedImage';
import { useCoverLightboxSrc } from '@/cover/lightbox';
import type { CoverArtRef } from '@/cover/types';
import LastfmIcon from '@/ui/LastfmIcon';
import WikipediaIcon from '@/ui/WikipediaIcon';
import StarRating from '@/ui/StarRating';
import { tooltipAttrs } from '@/ui/tooltipAttrs';
import { offlineActionPolicy, type OfflineActionPolicy } from '@/features/offline';

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

/**
 * Artist-detail header background (banner / fanart). Preloads the final image
 * and only then fades it in over the empty header — so the chosen image never
 * hard-cuts and no intermediate source flashes first. Reuses the shared
 * `album-detail-bg` / `-overlay` structure; the fade is a scoped inline opacity
 * so the class stays untouched for the album/playlist headers that share it.
 *
 * Mount with `key={url}` for a fresh element (and `loaded=false`) per source.
 * Both load paths are covered: `onLoad` for a network fetch, and the `ref`'s
 * `complete` check for an already-cached image whose `load` event can fire
 * before React attaches the handler.
 */
function ArtistHeaderBg({ url, position }: { url: string; position?: string }) {
  const [loaded, setLoaded] = useState(false);
  if (!url) return null;
  return (
    <>
      {/* Hidden preloader — drives `loaded`; the visible background is CSS. */}
      <img
        src={url}
        alt=""
        aria-hidden="true"
        style={{ display: 'none' }}
        onLoad={() => setLoaded(true)}
        ref={(el) => {
          if (el?.complete) setLoaded(true);
        }}
      />
      <div
        className="album-detail-bg"
        style={{
          backgroundImage: `url(${url})`,
          // Portrait-ish artist images (fanart / Navidrome) get a higher focal
          // point so the band's heads aren't cropped off the top on wide (2K+)
          // viewports, where `cover` scales the image up and overflows vertically.
          // The wide banner strip is left at the shared `center` (no override).
          ...(position ? { backgroundPosition: position } : {}),
          opacity: loaded ? 1 : 0,
          transition: 'opacity 0.4s ease',
        }}
        aria-hidden="true"
      />
      {loaded && <div className="album-detail-overlay" aria-hidden="true" />}
    </>
  );
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

  // Artist-detail header banner (§28, Option B): fanart.tv banner → the 16:9
  // fanart background cropped to the strip → empty (no regression when off).
  // Use the LOADED artist's id (not the route `id`), so the id, name and album
  // handed to the external-artwork hooks always describe the SAME artist. The
  // route `id` flips immediately on navigation while `artist`/`albums` refetch
  // a beat later — that mismatch previously wrote the previous artist's image
  // under the new artist's key (Sepultura's image under Lordi's id).
  const artistKey = artist.id;
  // An album from the artist's own list gives the §19 name→MusicBrainz fallback
  // the context it needs when the artist carries no Navidrome tag MBID.
  // Pick the first album that actually belongs to THIS artist. `albums` refetches
  // a beat after `artist` on navigation, so a stale album would run a mismatched
  // name→MusicBrainz query and could cache a wrong `no_mbid` for the new artist.
  const albumContext = albums.find((a) => a.artistId === artist.id)?.name;
  const banner = useArtistBanner(artistKey, {
    artistName: artist.name,
    albumTitle: albumContext,
  });
  const fanartBg = useArtistFanart(artistKey, {
    artistName: artist.name,
    albumTitle: albumContext,
  });
  // §28 stage 3: the Navidrome artist cover, the last fallback when neither an
  // external banner nor fanart exists. Resolved the same way the fullscreen
  // player resolves its artist background (`coverRef` is the artist cover ref).
  const ndArtist = usePlaybackCoverArt(coverRef ?? undefined, 2000, { fullRes: true });
  const ndArtistUrl = useCachedUrl(ndArtist.src, ndArtist.cacheKey, true);
  // Header background priority (§28): banner → fanart → Navidrome artist cover,
  // now user-configurable per surface. Shared with the mainstage hero via
  // backdropFromConfig so the two headers resolve and frame identically.
  const artistDetailBackdrop = useThemeStore((s) => s.backdrops.artistDetailHero);
  const headerBackdrop = backdropFromConfig(artistDetailBackdrop.sources, {
    banner,
    fanart: fanartBg,
    navidrome: ndArtistUrl,
  });
  const showHeaderBackdrop = artistDetailBackdrop.enabled;

  const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(artist.name)}`;

  return (
    <>
      {lightbox}

      {/* Same structure + classes as the album-detail header (AlbumHeader.tsx),
          with the fanart banner as the background instead of the album cover.
          `artist-detail-bleed` breaks out of the artist page's .content-body
          padding so it is full-bleed like the album page (flush .album-detail). */}
      <div className="album-detail-header artist-detail-bleed">
        {showHeaderBackdrop && (
          <ArtistHeaderBg key={headerBackdrop.url} url={headerBackdrop.url} position={headerBackdrop.position} />
        )}
        <div className="album-detail-content">
          <button className="btn btn-ghost album-detail-back" onClick={() => goBack()}>
            <ArrowLeft size={16} /> <span>{t('artistDetail.back')}</span>
          </button>
          <div className="album-detail-hero">
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

          <div className="compact-action-bar" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(info?.lastFmUrl || artist.name) && (
              <div className="artist-detail-links">
                {info?.lastFmUrl && (
                  <button
                    className="artist-ext-link"
                    onClick={() => openLink(info.lastFmUrl!, 'lastfm')}
                    {...tooltipAttrs(t('artistDetail.lastfmTooltip'))}
                  >
                    <LastfmIcon size={14} />
                    <span className="compact-btn-label">{openedLink === 'lastfm' ? t('artistDetail.openedInBrowser') : 'Last.fm'}</span>
                  </button>
                )}
                <button
                  className="artist-ext-link"
                  onClick={() => openLink(wikiUrl, 'wiki')}
                  {...tooltipAttrs(t('artistDetail.wikipediaTooltip'))}
                >
                  <WikipediaIcon size={14} />
                  <span className="compact-btn-label">{openedLink === 'wiki' ? t('artistDetail.openedInBrowser') : 'Wikipedia'}</span>
                </button>
              </div>
            )}

            {policy.canFavorite && (
              <button
                className="artist-ext-link"
                onClick={toggleStar}
                aria-label={isStarred ? t('artistDetail.favoriteRemove') : t('artistDetail.favoriteAdd')}
                data-tooltip={isStarred ? t('artistDetail.favoriteRemove') : t('artistDetail.favoriteAdd')}
                style={{ color: isStarred ? 'var(--accent)' : 'inherit', border: isStarred ? '1px solid var(--accent)' : undefined }}
              >
                <Heart size={14} fill={isStarred ? "currentColor" : "none"} />
                <span className="compact-btn-label">{t('artistDetail.favorite')}</span>
              </button>
            )}
          </div>

          <div className="compact-action-bar" style={{ display: 'flex', gap: '8px', marginTop: '1.5rem', flexWrap: 'wrap' }}>
            {albums.length > 0 && (
              <>
                <button
                  className="btn btn-primary"
                  onClick={handlePlayAll}
                  disabled={playAllLoading}
                  {...tooltipAttrs(t('artistDetail.playAllTooltip'))}
                >
                  {playAllLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Play size={16} />}
                  <span className="compact-btn-label">{t('artistDetail.playAll')}</span>
                </button>
                <button
                  className="btn btn-surface"
                  onClick={handleShuffle}
                  disabled={playAllLoading}
                  {...tooltipAttrs(t('artistDetail.shuffleTooltip'))}
                >
                  {playAllLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Shuffle size={16} />}
                  {!isMobile && <span className="compact-btn-label">{t('artistDetail.shuffle')}</span>}
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
              {!isMobile && <span className="compact-btn-label">{radioLoading ? t('artistDetail.loading') : t('artistDetail.radio')}</span>}
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
                  <span className="compact-btn-label">{
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
                  }</span>
                )}
              </button>
            )}
          </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
