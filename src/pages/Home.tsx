import { getArtists } from '../api/subsonicArtists';
import { getAlbumList, getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../api/subsonicTypes';
import React, { useEffect, useState } from 'react';
import Hero from '../components/Hero';
import AlbumRow from '../components/AlbumRow';
import SongRail from '../components/SongRail';
import BecauseYouLikeRail from '../components/BecauseYouLikeRail';
import LosslessAlbumsRail from '../components/LosslessAlbumsRail';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useHomeStore } from '../store/homeStore';
import { useAuthStore } from '../store/authStore';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '../utils/mix/mixRatingFilter';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { bumpPerfCounter } from '../utils/perf/perfTelemetry';
import { dedupeById } from '../utils/dedupeById';
import { shuffleArray } from '../utils/playback/shuffleArray';

/** Match Random Albums overshoot when mix filter uses album/artist axes so hero + discover row can still fill. */
const HOME_RANDOM_FETCH = 100;
const HOME_HERO_COUNT = 8;
const HOME_DISCOVER_SLICE = 20;
const HOME_DISCOVER_SONGS_SIZE = 18;
const HOME_ALBUM_ROW_ARTWORK_SIZE = 300;
const HOME_SONG_RAIL_ARTWORK_SIZE = 200;
const HOME_ARTWORK_WINDOWING = true;
// At least one viewport width of cards on first paint (low values left half the row as placeholders).
const HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET = 14;
const HOME_SONG_RAIL_INITIAL_ARTWORK_BUDGET = 16;
// Keep artwork enabled across Home rows in normal mode.
const HOME_ARTWORK_VISIBLE_ROW_BUDGET_WHEN_ENABLED = 8;

export default function Home() {
  const perfFlags = usePerfProbeFlags();
  const homeAlbumRowsDisabled = perfFlags.disableMainstageRails || perfFlags.disableHomeAlbumRows;
  const homeSongRailsDisabled = perfFlags.disableMainstageRails || perfFlags.disableHomeSongRails;
  const homeRailArtworkDisabled = perfFlags.disableMainstageRailArtwork || perfFlags.disableHomeRailArtwork;
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
  const [discoverSongs, setDiscoverSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    bumpPerfCounter('homeCommits');
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const mixCfg = getMixMinRatingsConfigFromAuth();
        const albumMix =
          mixCfg.enabled && (mixCfg.minAlbum > 0 || mixCfg.minArtist > 0);
        const randomSize = albumMix ? HOME_RANDOM_FETCH : HOME_DISCOVER_SLICE;
        const [s, n, rRaw, f, rp, artists, songs] = await Promise.all([
          getAlbumList('starred', 12).catch(() => []),
          getAlbumList('newest', 12).catch(() => []),
          getAlbumList('random', randomSize).catch(() => []),
          getAlbumList('frequent', 12).catch(() => []),
          getAlbumList('recent', 12).catch(() => []),
          isVisible('discoverArtists') ? getArtists().catch(() => []) : Promise.resolve<SubsonicArtist[]>([]),
          isVisible('discoverSongs')
            ? getRandomSongs(HOME_DISCOVER_SONGS_SIZE).catch(() => [] as SubsonicSong[])
            : Promise.resolve<SubsonicSong[]>([]),
        ]);
        if (cancelled) return;
        const r = dedupeById(await filterAlbumsByMixRatings(rRaw, mixCfg));
        setStarred(dedupeById(s));
        setRecent(dedupeById(n));
        setHeroAlbums(r.slice(0, HOME_HERO_COUNT));
        setRandom(r.slice(HOME_HERO_COUNT, HOME_DISCOVER_SLICE));
        setMostPlayed(dedupeById(f));
        setRecentlyPlayed(dedupeById(rp));
        setDiscoverSongs(dedupeById(songs));
        setRandomArtists(dedupeById(shuffleArray(artists)).slice(0, 16));
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
      const batchRaw =
        type === 'random' ? await filterAlbumsByMixRatings(more, mixCfg) : more;
      const batch = dedupeById(batchRaw);
      const newItems = batch.filter(m => !currentList.find(c => c.id === m.id));
      if (newItems.length > 0) setter(prev => [...prev, ...newItems]);
    } catch (e) {
      console.error('Failed to load more', e);
    }
  };

  const { t } = useTranslation();
  const navigate = useNavigate();
  let artworkRowsLeft = homeRailArtworkDisabled ? 0 : HOME_ARTWORK_VISIBLE_ROW_BUDGET_WHEN_ENABLED;
  const reserveArtworkRow = () => {
    if (artworkRowsLeft <= 0) return false;
    artworkRowsLeft -= 1;
    return true;
  };
  const recentArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeAlbumRowsDisabled &&
    isVisible('recent') &&
    recent.length > 0 &&
    reserveArtworkRow();
  const discoverArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeAlbumRowsDisabled &&
    isVisible('discover') &&
    random.length > 0 &&
    reserveArtworkRow();
  const discoverSongsArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeSongRailsDisabled &&
    isVisible('discoverSongs') &&
    discoverSongs.length > 0 &&
    reserveArtworkRow();
  const recentlyPlayedArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeAlbumRowsDisabled &&
    isVisible('recentlyPlayed') &&
    recentlyPlayed.length > 0 &&
    reserveArtworkRow();
  const starredArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeAlbumRowsDisabled &&
    isVisible('starred') &&
    starred.length > 0 &&
    reserveArtworkRow();
  const mostPlayedArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeAlbumRowsDisabled &&
    isVisible('mostPlayed') &&
    mostPlayed.length > 0 &&
    reserveArtworkRow();
  const becauseYouLikeHasSeed =
    mostPlayed.length > 0 || recentlyPlayed.length > 0 || starred.length > 0;
  const becauseYouLikeArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeAlbumRowsDisabled &&
    isVisible('becauseYouLike') &&
    becauseYouLikeHasSeed &&
    reserveArtworkRow();
  const losslessAlbumsArtworkEnabled =
    !homeRailArtworkDisabled &&
    !homeAlbumRowsDisabled &&
    isVisible('losslessAlbums') &&
    reserveArtworkRow();

  const homeLiteArtworkFx = perfFlags.disableHomeArtworkFx;
  const homeFlatArtworkClip = perfFlags.disableHomeArtworkClip;
  return (
    <div className={`animate-fade-in${homeLiteArtworkFx ? ' home-lite-artwork' : ''}${homeFlatArtworkClip ? ' home-flat-artwork-clip' : ''}`}>
      {!perfFlags.disableMainstageHero && isVisible('hero') && <Hero albums={heroAlbums} />}

      <div className="content-body" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
            <div className="spinner" />
          </div>
        ) : (
          <>
            {!homeAlbumRowsDisabled && isVisible('recent') && (
              <AlbumRow
                title={t('home.recent')}
                titleLink="/new-releases"
                albums={recent}
                onLoadMore={() => loadMore('newest', recent, setRecent)}
                moreText={t('home.loadMore')}
                disableArtwork={!recentArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
              />
            )}
            {!homeAlbumRowsDisabled && isVisible('becauseYouLike') && becauseYouLikeHasSeed && (
              <BecauseYouLikeRail
                mostPlayed={mostPlayed}
                recentlyPlayed={recentlyPlayed}
                starred={starred}
                disableArtwork={!becauseYouLikeArtworkEnabled}
              />
            )}
            {!homeAlbumRowsDisabled && isVisible('discover') && (
              <AlbumRow
                title={t('home.discover')}
                titleLink="/random/albums"
                albums={random}
                onLoadMore={() => loadMore('random', random, setRandom)}
                moreText={t('home.discoverMore')}
                disableArtwork={!discoverArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
              />
            )}
            {!homeSongRailsDisabled && isVisible('discoverSongs') && discoverSongs.length > 0 && (
              <SongRail
                title={t('home.discoverSongs')}
                songs={discoverSongs}
                disableArtwork={!discoverSongsArtworkEnabled}
                artworkSize={HOME_SONG_RAIL_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_SONG_RAIL_INITIAL_ARTWORK_BUDGET}
              />
            )}
            {!perfFlags.disableMainstageGridCards && isVisible('discoverArtists') && randomArtists.length > 0 && (
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
            {!homeAlbumRowsDisabled && isVisible('recentlyPlayed') && recentlyPlayed.length > 0 && (
              <AlbumRow
                title={t('home.recentlyPlayed')}
                albums={recentlyPlayed}
                onLoadMore={() => loadMore('recent', recentlyPlayed, setRecentlyPlayed)}
                moreText={t('home.loadMore')}
                disableArtwork={!recentlyPlayedArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
              />
            )}
            {!homeAlbumRowsDisabled && isVisible('starred') && starred.length > 0 && (
              <AlbumRow
                title={t('home.starred')}
                titleLink="/favorites"
                albums={starred}
                onLoadMore={() => loadMore('starred', starred, setStarred)}
                moreText={t('home.loadMore')}
                disableArtwork={!starredArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
              />
            )}
            {!homeAlbumRowsDisabled && isVisible('mostPlayed') && (
              <AlbumRow
                title={t('home.mostPlayed')}
                titleLink="/most-played"
                albums={mostPlayed}
                onLoadMore={() => loadMore('frequent', mostPlayed, setMostPlayed)}
                moreText={t('home.loadMore')}
                disableArtwork={!mostPlayedArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
              />
            )}
            {!homeAlbumRowsDisabled && isVisible('losslessAlbums') && (
              <LosslessAlbumsRail
                disableArtwork={!losslessAlbumsArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
