import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  SubsonicSong,
  getRandomSongs,
  buildCoverArtUrl,
  coverArtCacheKey,
} from '../api/subsonic';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import CachedImage from '../components/CachedImage';
import SongRail from '../components/SongRail';
import VirtualSongList from '../components/VirtualSongList';
import { playSongNow } from '../utils/playSong';

const RANDOM_RAIL_SIZE = 18;

export default function Tracks() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const enqueue = usePlayerStore(s => s.enqueue);

  const [hero, setHero] = useState<SubsonicSong | null>(null);
  const [heroLoading, setHeroLoading] = useState(false);

  const [random, setRandom] = useState<SubsonicSong[]>([]);
  const [randomLoading, setRandomLoading] = useState(true);

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

  useEffect(() => {
    if (!activeServerId) return;
    rerollHero();
    rerollRandom();
  }, [activeServerId, rerollHero, rerollRandom]);

  const heroCoverUrl = hero?.coverArt ? buildCoverArtUrl(hero.coverArt, 600) : '';

  // Hide the hero song from the random rail if the server happens to return it in
  // both fetches (Navidrome's getRandomSongs sometimes overlaps within a short window).
  const railSongs = useMemo(
    () => (hero ? random.filter(s => s.id !== hero.id) : random),
    [random, hero],
  );

  return (
    <div className="content-body animate-fade-in tracks-page">
      <header className="tracks-header">
        <div className="tracks-header-text">
          <h1 className="page-title">{t('tracks.title')}</h1>
          <p className="tracks-subtitle">{t('tracks.subtitle')}</p>
        </div>
      </header>

      {hero && (
        <section className="tracks-hero">
          <div className="tracks-hero-cover">
            {heroCoverUrl ? (
              <CachedImage
                src={heroCoverUrl}
                cacheKey={coverArtCacheKey(hero.coverArt!, 600)}
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

      <SongRail
        title={t('tracks.railRandom')}
        songs={railSongs}
        loading={randomLoading}
        onReroll={rerollRandom}
      />

      <VirtualSongList
        title={t('tracks.browseTitle')}
        emptyBrowseText={t('tracks.browseUnsupported')}
      />
    </div>
  );
}
