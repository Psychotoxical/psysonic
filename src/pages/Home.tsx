import { getArtists } from '../api/subsonicArtists';
import { getAlbumList, getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../api/subsonicTypes';
import { runLocalRandomSongs } from '../utils/library/browseTextSearch';
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
import { useLibraryCoverPrefetch } from '../cover/useLibraryCoverPrefetch';
import { primeAlbumCoversForDisplay, warmHomeMainstageCovers } from '../cover/warmDiskPeek';
import { readBecauseYouLikeCache } from '../store/becauseYouLikeCache';
import {
  isHomeFeedSnapshotEmpty,
  readHomeFeedCache,
  readHomeFeedCacheStale,
  writeHomeFeedCache,
  type HomeFeedSnapshot,
} from '../store/homeFeedCache';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useOfflineBrowseContext } from '../hooks/useOfflineBrowseContext';
import { useOfflineBrowseReloadToken } from '../hooks/useOfflineBrowseReloadToken';
import { useDevOfflineBrowseStore } from '../store/devOfflineBrowseStore';

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
const HOME_BECAUSE_CARD_COVER_CSS_PX = 160;
// Keep artwork enabled across Home rows in normal mode.
const HOME_ARTWORK_VISIBLE_ROW_BUDGET_WHEN_ENABLED = 8;

/**
 * Read the in-memory homeFeedCache synchronously at component mount time.
 * Uses Zustand getState() (not a hook) so it can be called from useState lazy
 * initializers — by the time the user navigates back to Home the store is
 * fully rehydrated and activeServerId is set, so on every return visit the
 * first render already has data, eliminating the empty-state flash.
 */
function getInitialHomeFeed(): HomeFeedSnapshot | null {
  const { activeServerId, musicLibraryFilterVersion } = useAuthStore.getState();
  if (!activeServerId) return null;
  return readHomeFeedCache(activeServerId, musicLibraryFilterVersion)
    ?? readHomeFeedCacheStale(activeServerId);
}

export default function Home() {
  const perfFlags = usePerfProbeFlags();
  const homeAlbumRowsDisabled = perfFlags.disableMainstageRails || perfFlags.disableHomeAlbumRows;
  const homeSongRailsDisabled = perfFlags.disableMainstageRails || perfFlags.disableHomeSongRails;
  const homeRailArtworkDisabled = perfFlags.disableMainstageRailArtwork || perfFlags.disableHomeRailArtwork;
  const homeSections = useHomeStore(s => s.sections);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const connStatus = useConnectionStatus().status;
  const devForceOffline = useDevOfflineBrowseStore(s => s.forceOffline);
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  // Mix-rating deps intentionally NOT subscribed here — they change during Zustand
  // rehydration and would trigger a second useEffect fire right after the first,
  // showing the cached home feed briefly and then replacing it (~500 ms later)
  // when the re-fetch with the rehydrated values completes. getMixMinRatingsConfigFromAuth
  // reads the current store state directly inside the effect so the correct
  // values are always used without re-triggering the effect on rehydration.
  const isVisible = (id: string) => homeSections.find(s => s.id === id)?.visible ?? true;

  const [starred, setStarred] = useState<SubsonicAlbum[]>(() => getInitialHomeFeed()?.starred ?? []);
  const [recent, setRecent] = useState<SubsonicAlbum[]>(() => getInitialHomeFeed()?.recent ?? []);
  const [random, setRandom] = useState<SubsonicAlbum[]>(() => getInitialHomeFeed()?.random ?? []);
  const [heroAlbums, setHeroAlbums] = useState<SubsonicAlbum[]>(() => getInitialHomeFeed()?.heroAlbums ?? []);
  const [mostPlayed, setMostPlayed] = useState<SubsonicAlbum[]>(() => getInitialHomeFeed()?.mostPlayed ?? []);
  const [recentlyPlayed, setRecentlyPlayed] = useState<SubsonicAlbum[]>(() => getInitialHomeFeed()?.recentlyPlayed ?? []);
  const [randomArtists, setRandomArtists] = useState<SubsonicArtist[]>(() => getInitialHomeFeed()?.randomArtists ?? []);
  const [discoverSongs, setDiscoverSongs] = useState<SubsonicSong[]>(() => getInitialHomeFeed()?.discoverSongs ?? []);
  // Pre-populated from cache → no loading spinner on return visits.
  const [loading, setLoading] = useState(() => getInitialHomeFeed() == null);
  // Track whether state was pre-populated from cache at mount so useEffect can
  // skip re-applying the same snapshot (avoids creating new array references
  // that would cause child components to re-render with unchanged data).
  const [wasPrePopulated] = useState(() => getInitialHomeFeed() != null);

  const applyFeedSnapshot = (snap: HomeFeedSnapshot) => {
    setStarred(snap.starred);
    setRecent(snap.recent);
    setRandom(snap.random);
    setHeroAlbums(snap.heroAlbums);
    setMostPlayed(snap.mostPlayed);
    setRecentlyPlayed(snap.recentlyPlayed);
    setRandomArtists(snap.randomArtists);
    setDiscoverSongs(snap.discoverSongs);
  };

  useEffect(() => {
    bumpPerfCounter('homeCommits');
  });

  useLibraryCoverPrefetch(
    [
      { albums: heroAlbums, priority: 'high' },
      { albums: recent, priority: 'high' },
      {
        albums: [...random, ...mostPlayed, ...recentlyPlayed, ...starred],
        artists: randomArtists,
        limit: 24,
        priority: 'low',
      },
      { songs: discoverSongs, limit: 16, priority: 'middle' },
    ],
    [heroAlbums, recent, random, mostPlayed, recentlyPlayed, starred, randomArtists, discoverSongs],
  );

  useEffect(() => {
    if (!activeServerId) return;
    let cancelled = false;
    const fetchFreshHomeFeed = async (): Promise<HomeFeedSnapshot | null> => {
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
          ? (runLocalRandomSongs(activeServerId, HOME_DISCOVER_SONGS_SIZE)
              .then(local => local ?? getRandomSongs(HOME_DISCOVER_SONGS_SIZE).catch(() => [] as SubsonicSong[]))
              .catch(() => [] as SubsonicSong[]))
          : Promise.resolve<SubsonicSong[]>([]),
      ]);
      const r = dedupeById(await filterAlbumsByMixRatings(rRaw, mixCfg));
      return {
        serverId: activeServerId,
        filterVersion: musicLibraryFilterVersion,
        savedAt: Date.now(),
        starred: dedupeById(s),
        recent: dedupeById(n),
        heroAlbums: r.slice(0, HOME_HERO_COUNT),
        random: r.slice(HOME_HERO_COUNT, HOME_DISCOVER_SLICE),
        mostPlayed: dedupeById(f),
        recentlyPlayed: dedupeById(rp),
        discoverSongs: dedupeById(songs),
        randomArtists: dedupeById(shuffleArray(artists)).slice(0, 16),
      };
    };

    const cached = readHomeFeedCache(activeServerId, musicLibraryFilterVersion)
      ?? (offlineBrowseActive ? readHomeFeedCacheStale(activeServerId) : null);
    if (cached) {
      // When lazy initializers already pre-populated state from this same
      // snapshot, re-applying it would only create new array references and
      // trigger unnecessary child re-renders with identical data.
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!wasPrePopulated) applyFeedSnapshot(cached);
      setLoading(false);
      void warmHomeMainstageCovers(cached);
      const becauseSnap = readBecauseYouLikeCache(activeServerId, musicLibraryFilterVersion);
      void primeAlbumCoversForDisplay(becauseSnap?.recs ?? [], HOME_BECAUSE_CARD_COVER_CSS_PX, {
        limit: 6,
      });
      // Keep the current visit visually stable, but prepare fresh data so the
      // next re-enter opens with a newer snapshot immediately.
      if (!offlineBrowseActive) {
        void (async () => {
          try {
            const fresh = await fetchFreshHomeFeed();
            if (!fresh || cancelled || isHomeFeedSnapshotEmpty(fresh)) return;
            writeHomeFeedCache(fresh);
            void warmHomeMainstageCovers(fresh);
          } catch {
            /* ignore */
          }
        })();
      }
      return () => {
        cancelled = true;
      };
    }

    const stale = offlineBrowseActive ? readHomeFeedCacheStale(activeServerId) : null;
    if (stale) {
      applyFeedSnapshot(stale);
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    (async () => {
      try {
        const snap = await fetchFreshHomeFeed();
        if (!snap) return;
        if (cancelled) return;
        if (offlineBrowseActive && isHomeFeedSnapshotEmpty(snap)) return;
        writeHomeFeedCache(snap);
        applyFeedSnapshot(snap);
        if (!cancelled) setLoading(false);
        void warmHomeMainstageCovers(snap);
        const becauseSnap = readBecauseYouLikeCache(activeServerId, musicLibraryFilterVersion);
        void primeAlbumCoversForDisplay(becauseSnap?.recs ?? [], HOME_BECAUSE_CARD_COVER_CSS_PX, {
          limit: 6,
        });
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // isVisible / wasPrePopulated are read for one-shot gating inside the loader;
    // the home feed reloads on server / filter / section / offline changes only,
    // not when visibility or the pre-populate flag flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeServerId,
    musicLibraryFilterVersion,
    homeSections,
    offlineBrowseActive,
    offlineBrowseReloadTs,
  ]);

  /** When offline toggles without a library-filter bump, re-apply stale cache if the feed was cleared. */
  useEffect(() => {
    if (!activeServerId || !offlineBrowseActive) return;
    const stale = readHomeFeedCacheStale(activeServerId);
    if (!stale || isHomeFeedSnapshotEmpty(stale)) return;
    if (recent.length > 0 || random.length > 0 || heroAlbums.length > 0) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyFeedSnapshot(stale);
    setLoading(false);
  }, [activeServerId, connStatus, devForceOffline, offlineBrowseActive]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Treat the library as empty when every album endpoint returned zero. The
  // song/artist rails can be empty for non-empty libraries (rare server quirks),
  // so they don't count toward this signal.
  const libraryEmpty =
    !loading &&
    recent.length === 0 &&
    random.length === 0 &&
    mostPlayed.length === 0 &&
    recentlyPlayed.length === 0 &&
    starred.length === 0;
  // Every section toggled off in Settings → Personalisation → Mainstage. The
  // page would otherwise be entirely blank, so surface a guided empty state
  // pointing back at the toggles (or the option to hide Mainstage from the
  // sidebar) instead of leaving the user on nothing.
  const allSectionsHidden = homeSections.every(s => !s.visible);
  return (
    <div className={`animate-fade-in${homeLiteArtworkFx ? ' home-lite-artwork' : ''}${homeFlatArtworkClip ? ' home-flat-artwork-clip' : ''}`}>
      {!loading && !perfFlags.disableMainstageHero && isVisible('hero') && <Hero albums={heroAlbums} />}

      <div className="content-body" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
            <div className="spinner" />
          </div>
        ) : allSectionsHidden ? (
          <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('home.mainstageEmptyTitle')}
            </div>
            <div style={{ maxWidth: 460 }}>{t('home.mainstageEmptyBody')}</div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: '0.5rem' }}
              onClick={() => navigate('/settings', { state: { tab: 'personalisation' } })}
            >
              {t('home.mainstageEmptyCta')}
            </button>
          </div>
        ) : libraryEmpty ? (
          <div className="empty-state" style={{ padding: '4rem 1rem', textAlign: 'center' }}>
            {t('common.libraryEmpty')}
          </div>
        ) : (
          <>
            {!homeAlbumRowsDisabled && isVisible('recent') && (
              <AlbumRow
                title={t('sidebar.newReleases')}
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
