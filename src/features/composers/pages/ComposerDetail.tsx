import { star, unstar } from '@/lib/api/subsonicStarRating';
import { getArtist, getArtistInfo } from '@/lib/api/subsonicArtists';
import type { SubsonicArtist, SubsonicAlbum, SubsonicArtistInfo } from '@/lib/api/subsonicTypes';
import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ndListAlbumsByArtistRole } from '@/lib/api/navidromeBrowse';
import { AlbumCard } from '@/features/album';
import { ArtistHeroCover } from '@/cover/artistHero';
import { coverArtRef } from '@/cover/ref';
import { useCoverLightboxSrc } from '@/cover/lightbox';
import { ArrowLeft, Users, Heart, Feather, Share2 } from 'lucide-react';
import WikipediaIcon from '@/ui/WikipediaIcon';
import { open } from '@tauri-apps/plugin-shell';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import { copyEntityShareLink } from '@/lib/share/copyEntityShareLink';
import { showToast } from '@/lib/dom/toast';
import { sanitizeHtml } from '@/lib/util/sanitizeHtml';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { albumGridWarmCovers } from '@/cover/layoutSizes';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';

export default function ComposerDetail() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artist, setArtist] = useState<SubsonicArtist | null>(null);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [info, setInfo] = useState<SubsonicArtistInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [isStarred, setIsStarred] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [headerCoverFailed, setHeaderCoverFailed] = useState(false);
  const [openedLink, setOpenedLink] = useState<string | null>(null);

  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  // Subsonic `getArtist.view` only follows AlbumArtist relations, so for a
  // composer-only credit it returns the right name + bio but zero albums.
  // Native API `/api/album?_filters={"role_composer_id":"<id>"}` is the only
  // endpoint that walks the participants graph for non-AlbumArtist roles.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([
      getArtist(id).catch(() => null),
      ndListAlbumsByArtistRole(id, 'composer', 0, 500).catch(err => {
        console.warn('[psysonic] composer albums load failed:', err);
        return [] as SubsonicAlbum[];
      }),
    ]).then(([artistData, composerAlbums]) => {
      if (cancelled) return;
      if (artistData) {
        setArtist(artistData.artist);
        setIsStarred(!!artistData.artist.starred);
      }
      setAlbums(composerAlbums);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [id, musicLibraryFilterVersion]);

  // Bio + Last.fm image — Last.fm matches by name, so well-known composers
  // (Bach, Mozart, Chopin) hit; obscure ones get an empty bio. Failure is
  // silent — we just show the initial-letter avatar instead.
  // Bio is library-independent (Last.fm is global), so this effect tracks
  // [id] only — keeping the bio visible across music-library scope changes.
  // The info reset lives here, not in the load effect, or a scope bump would
  // wipe the bio without re-fetching it.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInfo(null);
    getArtistInfo(id, { similarArtistCount: 0 })
      .then(i => { if (!cancelled) setInfo(i ?? null); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeaderCoverFailed(false);
  }, [id]);

  const coverId = artist?.coverArt || artist?.id || '';
  const coverFallbackRef = useMemo(
    () => (coverId ? coverArtRef(coverId) : null),
    [coverId],
  );
  const { open: openLightbox, lightbox } = useCoverLightboxSrc(coverFallbackRef, {
    alt: artist?.name ?? t('composerDetail.unknownComposer'),
  });

  const toggleStar = async () => {
    if (!artist) return;
    const next = !isStarred;
    setIsStarred(next);
    setStarredOverride(artist.id, next);
    try {
      const meta = {
        serverId: artist.serverId,
        name: artist.name,
        albumCount: artist.albumCount,
      };
      if (next) await star(artist.id, 'artist', meta);
      else await unstar(artist.id, 'artist', meta);
    } catch (err) {
      console.warn('[psysonic] composer star failed:', err);
      setIsStarred(!next);
      setStarredOverride(artist.id, !next);
    }
  };

  const openLink = (url: string, key: string) => {
    setOpenedLink(key);
    open(url).catch(() => {});
    setTimeout(() => setOpenedLink(null), 2500);
  };

  const handleShareComposer = async () => {
    if (!id || !artist) return;
    try {
      const ok = await copyEntityShareLink('composer', artist.id);
      if (ok) showToast(t('contextMenu.shareCopied'));
      else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
    } catch {
      showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
    }
  };

  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  // Real not-found only when neither metadata nor works came back. If getArtist
  // failed but ndListAlbumsByArtistRole succeeded, render a degraded header so
  // a flaky Subsonic endpoint doesn't hide the works the user came here for.
  if (!artist && albums.length === 0) {
    return (
      <div className="content-body">
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>
          {t('composerDetail.notFound')}
        </div>
      </div>
    );
  }

  const displayName = artist?.name || t('composerDetail.unknownComposer');
  const wikiUrl = artist?.name
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(artist.name)}`
    : '';

  const hasHeroImage = Boolean(
    info?.largeImageUrl || info?.mediumImageUrl || coverId,
  );

  return (
    <div className="content-body animate-fade-in">
      <button
        className="btn btn-ghost"
        onClick={() => navigate(-1)}
        style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        <ArrowLeft size={16} /> <span>{t('composerDetail.back')}</span>
      </button>

      {lightbox}

      <div className="artist-detail-header">
        <div className="artist-detail-avatar" style={{ position: 'relative' }}>
          {hasHeroImage && !headerCoverFailed && id ? (
            <button
              className="artist-detail-avatar-btn"
              onClick={openLightbox}
              aria-label={displayName}
            >
              <ArtistHeroCover
                artistId={id}
                artistInfo={info}
                coverFallback={coverFallbackRef}
                displayCssPx={300}
                surface="sparse"
                alt={displayName}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={() => setHeaderCoverFailed(true)}
              />
            </button>
          ) : (
            <Feather size={64} color="var(--text-muted)" />
          )}
        </div>

        <div className="artist-detail-meta">
          <h1 className="page-title" style={{ fontSize: '3rem', marginBottom: '0.25rem' }}>
            {displayName}
          </h1>
          <div style={{ color: 'var(--text-secondary)', fontSize: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users size={14} />
            <span>{t('composerDetail.workCount', { count: albums.length })}</span>
          </div>

          <div className="compact-action-bar" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {wikiUrl && (
              <div className="artist-detail-links">
                <button className="artist-ext-link" onClick={() => openLink(wikiUrl, 'wiki')} aria-label={t('artistDetail.wikipediaTooltip')} data-tooltip={t('artistDetail.wikipediaTooltip')}>
                  <WikipediaIcon size={14} />
                  <span className="compact-btn-label">{openedLink === 'wiki' ? t('artistDetail.openedInBrowser') : 'Wikipedia'}</span>
                </button>
              </div>
            )}

            {artist && (
              <button
                className="artist-ext-link"
                onClick={toggleStar}
                aria-label={isStarred ? t('artistDetail.favoriteRemove') : t('artistDetail.favoriteAdd')}
                data-tooltip={isStarred ? t('artistDetail.favoriteRemove') : t('artistDetail.favoriteAdd')}
                style={{ color: isStarred ? 'var(--accent)' : 'inherit', border: isStarred ? '1px solid var(--accent)' : undefined }}
              >
                <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
                <span className="compact-btn-label">{t('artistDetail.favorite')}</span>
              </button>
            )}

            {artist && (
              <button
                type="button"
                className="artist-ext-link"
                onClick={handleShareComposer}
                aria-label={t('composerDetail.shareComposer')}
                data-tooltip={t('composerDetail.shareComposer')}
              >
                <Share2 size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {info?.biography && (
        <div className="np-info-card artist-bio-card" style={{ marginTop: '2rem' }}>
          <div className="np-card-header">
            <h3 className="np-card-title">{t('composerDetail.about')}</h3>
          </div>
          <div className="np-artist-bio-row">
            <div className="np-bio-wrap">
              <div
                className={`np-bio-text${bioExpanded ? ' expanded' : ''}`}
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(info.biography) }}
              />
              <button className="np-bio-toggle" onClick={() => setBioExpanded(v => !v)}>
                {bioExpanded ? t('nowPlaying.showLess') : t('nowPlaying.readMore')}
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 className="section-title" style={{ marginTop: '2rem', marginBottom: '1rem' }}>
        {t('composerDetail.works')}
      </h2>
      {albums.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          {t('composerDetail.noWorks')}
        </div>
      ) : (
        <VirtualCardGrid
          items={albums}
          itemKey={(a, i) => `${a.id}-${i}`}
          rowVariant="album"
          disableVirtualization={perfFlags.disableMainstageVirtualLists}
          layoutSignal={albums.length}
          warmGridCovers={albumGridWarmCovers()}
          renderItem={a => <AlbumCard album={a} />}
        />
      )}
    </div>
  );
}
