import React, { useEffect, useState } from 'react';
import Hero from '../components/Hero';
import AlbumRow from '../components/AlbumRow';
import { getAlbumList, getArtists, SubsonicAlbum, SubsonicArtist } from '../api/subsonic';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useHomeStore } from '../store/homeStore';
import { useAuthStore } from '../store/authStore';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '../utils/mixRatingFilter';

/** Match Random Albums overshoot when mix filter uses album/artist axes so hero + discover row can still fill. */
const HOME_RANDOM_FETCH = 100;
const HOME_HERO_COUNT = 8;
const HOME_DISCOVER_SLICE = 20;

export default function Home() {
  const homeSections = useHomeStore(s => s.sections);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const mixMinRatingFilterEnabled = useAuthStore(s => s.mixMinRatingFilterEnabled);
  const mixMinRatingAlbum = useAuthStore(s => s.mixMinRatingAlbum);
  const mixMinRatingArtist = useAuthStore(s => s.mixMinRatingArtist);
  const isVisible = (id: string) => homeSections.find(s => s.id === id)?.visible ?? true;

  const [starred, setStarred] = useState<SubsonicAlbum[]>([]);
  const [recent, setRecent] = useState<SubsonicAlbum[]>([]);
  const [random, setRandom] = useState<SubsonicAlbum[]>([]);
  const [heroAlbums, setHeroAlbums] = useState<SubsonicAlbum[]>([]);
  const [mostPlayed, setMostPlayed] = useState<SubsonicAlbum[]>([]);
  const [recentlyPlayed, setRecentlyPlayed] = useState<SubsonicAlbum[]>([]);
  const [randomArtists, setRandomArtists] = useState<SubsonicArtist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const mixCfg = getMixMinRatingsConfigFromAuth();
        const albumMix =
          mixCfg.enabled && (mixCfg.minAlbum > 0 || mixCfg.minArtist > 0);
        const randomSize = albumMix ? HOME_RANDOM_FETCH : HOME_DISCOVER_SLICE;
        const [s, n, rRaw, f, rp, artists] = await Promise.all([
          getAlbumList('starred', 12).catch(() => []),
          getAlbumList('newest', 12).catch(() => []),
          getAlbumList('random', randomSize).catch(() => []),
          getAlbumList('frequent', 12).catch(() => []),
          getAlbumList('recent', 12).catch(() => []),
          isVisible('discoverArtists') ? getArtists().catch(() => []) : Promise.resolve<SubsonicArtist[]>([]),
        ]);
        if (cancelled) return;
        const r = await filterAlbumsByMixRatings(rRaw, mixCfg);
        setStarred(s);
        setRecent(n);
        setHeroAlbums(r.slice(0, HOME_HERO_COUNT));
        setRandom(r.slice(HOME_HERO_COUNT, HOME_DISCOVER_SLICE));
        setMostPlayed(f);
        setRecentlyPlayed(rp);
        const shuffled = [...artists];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        setRandomArtists(shuffled.slice(0, 16));
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [
    activeServerId,
    musicLibraryFilterVersion,
    homeSections,
    mixMinRatingFilterEnabled,
    mixMinRatingAlbum,
    mixMinRatingArtist,
  ]);

  const loadMore = async (
    type: 'starred' | 'newest' | 'random' | 'frequent' | 'recent',
    currentList: SubsonicAlbum[],
    setter: React.Dispatch<React.SetStateAction<SubsonicAlbum[]>>
  ) => {
    try {
      const more = await getAlbumList(type, 12, currentList.length);
      const mixCfg = getMixMinRatingsConfigFromAuth();
      const batch =
        type === 'random' ? await filterAlbumsByMixRatings(more, mixCfg) : more;
      const newItems = batch.filter(m => !currentList.find(c => c.id === m.id));
      if (newItems.length > 0) setter(prev => [...prev, ...newItems]);
    } catch (e) {
      console.error('Failed to load more', e);
    }
  };

  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="animate-fade-in">
      {isVisible('hero') && <Hero albums={heroAlbums} />}

      <div className="content-body" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
            <div className="spinner" />
          </div>
        ) : (
          <>
            {isVisible('recent') && (
              <AlbumRow
                title={t('home.recent')}
                titleLink="/new-releases"
                albums={recent}
                onLoadMore={() => loadMore('newest', recent, setRecent)}
                moreText={t('home.loadMore')}
              />
            )}
            {isVisible('discover') && (
              <AlbumRow
                title={t('home.discover')}
                titleLink="/random/albums"
                albums={random}
                onLoadMore={() => loadMore('random', random, setRandom)}
                moreText={t('home.discoverMore')}
              />
            )}
            {isVisible('discoverArtists') && randomArtists.length > 0 && (
              <section className="album-row-section">
                <div className="album-row-header">
                  <NavLink to="/artists" className="section-title-link" style={{ marginBottom: 0 }}>
                    {t('home.discoverArtists')}<ChevronRight size={18} className="section-title-chevron" />
                  </NavLink>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {randomArtists.map(a => (
                    <button key={a.id} className="artist-ext-link" onClick={() => navigate(`/artist/${a.id}`)}>
                      {a.name}
                    </button>
                  ))}
                  <button className="artist-ext-link" onClick={() => navigate('/artists')}
                    style={{ opacity: 0.6 }}>
                    {t('home.discoverArtistsMore')} →
                  </button>
                </div>
              </section>
            )}
            {isVisible('recentlyPlayed') && recentlyPlayed.length > 0 && (
              <AlbumRow
                title={t('home.recentlyPlayed')}
                albums={recentlyPlayed}
                onLoadMore={() => loadMore('recent', recentlyPlayed, setRecentlyPlayed)}
                moreText={t('home.loadMore')}
              />
            )}
            {isVisible('starred') && starred.length > 0 && (
              <AlbumRow
                title={t('home.starred')}
                titleLink="/favorites"
                albums={starred}
                onLoadMore={() => loadMore('starred', starred, setStarred)}
                moreText={t('home.loadMore')}
              />
            )}
            {isVisible('mostPlayed') && (
              <AlbumRow
                title={t('home.mostPlayed')}
                titleLink="/most-played"
                albums={mostPlayed}
                onLoadMore={() => loadMore('frequent', mostPlayed, setMostPlayed)}
                moreText={t('home.loadMore')}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
