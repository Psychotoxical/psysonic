import { AlbumCoverArtImage } from '../../cover/AlbumCoverArtImage';
import { getRandomSongs } from '../../api/subsonicLibrary';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { songToTrack } from '../../utils/playback/songToTrack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, ListPlus, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import SongRail from '../SongRail';
import { playSongNow } from '../../utils/playback/playSong';
import { ndListSongs, ndInvalidateSongsCache } from '../../api/navidromeBrowse';
import { usePerfProbeFlags } from '../../utils/perf/perfFlags';
import { useNavigateToAlbum } from '../../hooks/useNavigateToAlbum';
import { useNavigateToArtist } from '../../hooks/useNavigateToArtist';
import { OpenArtistRefInline } from '../OpenArtistRefInline';
import { resolveTrackArtistRefs } from '../../utils/playback/trackArtistRefs';

const RANDOM_RAIL_SIZE = 18;
const RATED_RAIL_FETCH = 60;
const RATED_RAIL_DISPLAY = 30;
const RATED_RAIL_CACHE_MS = 60_000;
const TRACKS_SONG_RAIL_WINDOWING = true;
const TRACKS_SONG_RAIL_INITIAL_ARTWORK_BUDGET = 14;

/** Tracks hub hero + song rails (above the browse-all list). */
export default function TracksPageChrome({
  onLayoutReady,
  hideDiscoveryChrome = false,
}: {
  /** Fires once when hero + rails finish their initial load (or fail). */
  onLayoutReady?: () => void;
  /** When true, skip hero and song rails (active scoped search). */
  hideDiscoveryChrome?: boolean;
}) {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const navigateToArtist = useNavigateToArtist();
  const navigateToAlbum = useNavigateToAlbum();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const enqueue = usePlayerStore(s => s.enqueue);

  const [hero, setHero] = useState<SubsonicSong | null>(null);
  const [heroLoading, setHeroLoading] = useState(false);
  const [random, setRandom] = useState<SubsonicSong[]>([]);
  const [randomLoading, setRandomLoading] = useState(true);
  const [rated, setRated] = useState<SubsonicSong[]>([]);
  const [ratedLoading, setRatedLoading] = useState(true);
  const [ratedSupported, setRatedSupported] = useState(true);
  const layoutReadyNotifiedRef = useRef(false);

  const rerollHero = useCallback(async () => {
    setHeroLoading(true);
    try {
      const picks = await getRandomSongs(1);
      if (picks[0]) setHero(picks[0]);
    } finally {
      setHeroLoading(false);
    }
  }, []);

  const rerollRandom = useCallback(async () => {
    setRandomLoading(true);
    try {
      setRandom(await getRandomSongs(RANDOM_RAIL_SIZE));
    } finally {
      setRandomLoading(false);
    }
  }, []);

  const reloadRated = useCallback(async () => {
    setRatedLoading(true);
    try {
      const songs = await ndListSongs(0, RATED_RAIL_FETCH, 'rating', 'DESC', RATED_RAIL_CACHE_MS);
      const filtered = songs.filter(s => (s.userRating ?? 0) > 0).slice(0, RATED_RAIL_DISPLAY);
      setRated(filtered);
      setRatedSupported(true);
    } catch {
      setRated([]);
      setRatedSupported(false);
    } finally {
      setRatedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeServerId || hideDiscoveryChrome) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    rerollHero();
    rerollRandom();
    reloadRated();
  }, [activeServerId, hideDiscoveryChrome, rerollHero, rerollRandom, reloadRated]);

  useEffect(() => {
    if (!onLayoutReady || layoutReadyNotifiedRef.current) return;
    if (hideDiscoveryChrome || !activeServerId) {
      layoutReadyNotifiedRef.current = true;
      onLayoutReady();
      return;
    }
    if (heroLoading || randomLoading || ratedLoading) return;
    layoutReadyNotifiedRef.current = true;
    onLayoutReady();
  }, [activeServerId, hideDiscoveryChrome, onLayoutReady, heroLoading, randomLoading, ratedLoading]);

  const railSongs = useMemo(
    () => (hero ? random.filter(s => s.id !== hero.id) : random),
    [random, hero],
  );

  const heroArtistRefs = hero ? resolveTrackArtistRefs(hero) : [];

  return (
    <>
      {!perfFlags.disableMainstageStickyHeader && (
        <header className="tracks-header">
          <div className="tracks-header-text">
            <h1 className="page-title">{t('tracks.title')}</h1>
            {!hideDiscoveryChrome && (
              <p className="tracks-subtitle">{t('tracks.subtitle')}</p>
            )}
          </div>
        </header>
      )}

      {!perfFlags.disableMainstageHero && !hideDiscoveryChrome && hero && (
        <section className="tracks-hero">
          <div className="tracks-hero-cover">
            {hero.albumId && hero.coverArt ? (
              <AlbumCoverArtImage
                albumId={hero.albumId}
                coverArt={hero.coverArt}
                displayCssPx={600}
                surface="sparse"
                alt=""
              />
            ) : (
              <div className="tracks-hero-cover-placeholder" />
            )}
          </div>
          <div className="tracks-hero-content">
            <span className="tracks-hero-eyebrow">
              <Sparkles size={14} />
              {t('tracks.heroEyebrow')}
            </span>
            <h2 className="tracks-hero-title" title={hero.title}>{hero.title}</h2>
            <p className="tracks-hero-meta">
              <OpenArtistRefInline
                refs={heroArtistRefs}
                fallbackName={hero.artist}
                onGoArtist={id => navigateToArtist(id)}
                as="none"
                linkTag="span"
                linkClassName="track-artist-link"
                separatorClassName="track-artist-sep"
              />
              {hero.album && (
                <>
                  <span className="tracks-hero-meta-dot">·</span>
                  <span
                    className={hero.albumId ? 'track-artist-link' : ''}
                    style={{ cursor: hero.albumId ? 'pointer' : 'default' }}
                    onClick={() => hero.albumId && navigateToAlbum(hero.albumId)}
                  >{hero.album}</span>
                </>
              )}
            </p>
            <div className="tracks-hero-actions">
              <button className="btn btn-primary" onClick={() => playSongNow(hero)}>
                <Play size={16} fill="currentColor" /> {t('tracks.playSong')}
              </button>
              <button className="btn btn-surface" onClick={() => enqueue([songToTrack(hero)])}>
                <ListPlus size={16} /> {t('tracks.enqueueSong')}
              </button>
              <button
                className="btn btn-surface"
                onClick={rerollHero}
                disabled={heroLoading}
                aria-label={t('tracks.heroReroll')}
                data-tooltip={t('tracks.heroReroll')}
                data-tooltip-pos="top"
              >
                <RefreshCw size={16} className={heroLoading ? 'is-spinning' : ''} />
              </button>
            </div>
          </div>
        </section>
      )}

      {!perfFlags.disableMainstageRails && !hideDiscoveryChrome && ratedSupported && (ratedLoading || rated.length > 0) && (
        <SongRail
          title={t('tracks.railHighlyRated')}
          songs={rated}
          loading={ratedLoading}
          onReroll={() => { ndInvalidateSongsCache(); return reloadRated(); }}
          windowArtworkByViewport={TRACKS_SONG_RAIL_WINDOWING}
          initialArtworkBudget={TRACKS_SONG_RAIL_INITIAL_ARTWORK_BUDGET}
        />
      )}

      {!perfFlags.disableMainstageRails && !hideDiscoveryChrome && (
        <SongRail
          title={t('tracks.railRandom')}
          songs={railSongs}
          loading={randomLoading}
          onReroll={rerollRandom}
          windowArtworkByViewport={TRACKS_SONG_RAIL_WINDOWING}
          initialArtworkBudget={TRACKS_SONG_RAIL_INITIAL_ARTWORK_BUDGET}
        />
      )}
    </>
  );
}
