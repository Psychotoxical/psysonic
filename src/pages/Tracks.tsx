import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import CachedImage from '../components/CachedImage';
import SongRail from '../components/SongRail';
import VirtualSongList from '../components/VirtualSongList';
import { playSongNow } from '../utils/playback/playSong';
import { ndListSongs, ndInvalidateSongsCache } from '../api/navidromeBrowse';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';

const RANDOM_RAIL_SIZE = 18;
/** Over-fetch buffer so the client-side `userRating > 0` filter still leaves
 *  enough cards for the rail. Server-side rating filter on Navidrome's REST
 *  is finicky and not yet wired through — revisit when verified. */
const RATED_RAIL_FETCH = 60;
const RATED_RAIL_DISPLAY = 30;
/** Stay-fresh window for the Highly Rated rail. Cleared on rating mutation, so
 *  the only staleness path is a reroll-button click after >60 s. */
const RATED_RAIL_CACHE_MS = 60_000;
/** Match Home: only mount artwork for cards near the horizontal viewport. */
const TRACKS_SONG_RAIL_WINDOWING = true;
const TRACKS_SONG_RAIL_INITIAL_ARTWORK_BUDGET = 14;

export default function Tracks() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const enqueue = usePlayerStore(s => s.enqueue);

  const [hero, setHero] = useState<SubsonicSong | null>(null);
  const [heroLoading, setHeroLoading] = useState(false);

  const [random, setRandom] = useState<SubsonicSong[]>([]);
  const [randomLoading, setRandomLoading] = useState(true);

  const [rated, setRated] = useState<SubsonicSong[]>([]);
  const [ratedLoading, setRatedLoading] = useState(true);
  /** Hide the rail entirely on non-Navidrome servers (REST call throws) so we don't show an empty section. */
  const [ratedSupported, setRatedSupported] = useState(true);

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
      const r = await getRandomSongs(RANDOM_RAIL_SIZE);
      setRandom(r);
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
      // Non-Navidrome server, or REST endpoint refused → silently hide the rail.
      setRated([]);
      setRatedSupported(false);
    } finally {
      setRatedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeServerId) return;
    rerollHero();
    rerollRandom();
    reloadRated();
  }, [activeServerId, rerollHero, rerollRandom, reloadRated]);

  const heroCoverUrl = useMemo(
    () => (hero?.coverArt ? buildCoverArtUrl(hero.coverArt, 600) : ''),
    [hero?.coverArt],
  );
  const heroCoverKey = useMemo(
    () => (hero?.coverArt ? coverArtCacheKey(hero.coverArt, 600) : ''),
    [hero?.coverArt],
  );

  // Hide the hero song from the random rail if the server happens to return it in
  // both fetches (Navidrome's getRandomSongs sometimes overlaps within a short window).
  const railSongs = useMemo(
    () => (hero ? random.filter(s => s.id !== hero.id) : random),
    [random, hero],
  );

  return (
    <div className="content-body animate-fade-in tracks-page">
      {!perfFlags.disableMainstageStickyHeader && (
        <header className="tracks-header">
          <div className="tracks-header-text">
            <h1 className="page-title">{t('tracks.title')}</h1>
            <p className="tracks-subtitle">{t('tracks.subtitle')}</p>
          </div>
        </header>
      )}

      {!perfFlags.disableMainstageHero && hero && (
        <section className="tracks-hero">
          <div className="tracks-hero-cover">
            {heroCoverUrl ? (
              <CachedImage
                src={heroCoverUrl}
                cacheKey={heroCoverKey}
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
              <span
                className={hero.artistId ? 'track-artist-link' : ''}
                style={{ cursor: hero.artistId ? 'pointer' : 'default' }}
                onClick={() => hero.artistId && navigate(`/artist/${hero.artistId}`)}
              >{hero.artist}</span>
              {hero.album && (
                <>
                  <span className="tracks-hero-meta-dot">·</span>
                  <span
                    className={hero.albumId ? 'track-artist-link' : ''}
                    style={{ cursor: hero.albumId ? 'pointer' : 'default' }}
                    onClick={() => hero.albumId && navigate(`/album/${hero.albumId}`)}
                  >{hero.album}</span>
                </>
              )}
            </p>
            <div className="tracks-hero-actions">
              <button
                className="btn btn-primary"
                onClick={() => playSongNow(hero)}
              >
                <Play size={16} fill="currentColor" /> {t('tracks.playSong')}
              </button>
              <button
                className="btn"
                onClick={() => enqueue([songToTrack(hero)])}
              >
                <ListPlus size={16} /> {t('tracks.enqueueSong')}
              </button>
              <button
                className="btn btn-ghost"
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

      {!perfFlags.disableMainstageRails && ratedSupported && (ratedLoading || rated.length > 0) && (
        <SongRail
          title={t('tracks.railHighlyRated')}
          songs={rated}
          loading={ratedLoading}
          onReroll={() => { ndInvalidateSongsCache(); return reloadRated(); }}
          windowArtworkByViewport={TRACKS_SONG_RAIL_WINDOWING}
          initialArtworkBudget={TRACKS_SONG_RAIL_INITIAL_ARTWORK_BUDGET}
        />
      )}

      {!perfFlags.disableMainstageRails && (
        <SongRail
          title={t('tracks.railRandom')}
          songs={railSongs}
          loading={randomLoading}
          onReroll={rerollRandom}
          windowArtworkByViewport={TRACKS_SONG_RAIL_WINDOWING}
          initialArtworkBudget={TRACKS_SONG_RAIL_INITIAL_ARTWORK_BUDGET}
        />
      )}

      {!perfFlags.disableMainstageVirtualLists && (
        <VirtualSongList
          title={t('tracks.browseTitle')}
          emptyBrowseText={t('tracks.browseUnsupported')}
        />
      )}
    </div>
  );
}
