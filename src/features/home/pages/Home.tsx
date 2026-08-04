import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import Hero from '@/features/home/components/Hero';
import { AlbumRow } from '@/features/album';
import SongRail from '@/features/home/components/SongRail';
import BecauseYouLikeRail from '@/features/home/components/BecauseYouLikeRail';
import { LosslessAlbumsRail } from '@/features/album';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { useHomeStore } from '@/features/home/store/homeStore';
import { useAuthStore } from '@/store/authStore';
import {
  filterAlbumsByMixRatingsAcrossServers,
  getMixMinRatingsConfigFromAuth,
} from '@/features/playback/utils/mixRatingFilter';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import {
  usePsyLabDebugTraceEnabled,
  usePsyLabDebugTraceRevision,
  usePsyLabDebugTraces,
} from '@/lib/perf/psyLabDebugTraces';
import { bumpPerfCounter } from '@/lib/perf/perfTelemetry';
import { useLibraryCoverPrefetch } from '@/cover/useLibraryCoverPrefetch';
import { primeAlbumCoversForDisplay, warmHomeMainstageCovers } from '@/cover/warmDiskPeek';
import { readBecauseYouLikeCache } from '@/features/home/store/becauseYouLikeCache';
import {
  isHomeFeedSnapshotEmpty,
  readHomeFeedCache,
  readHomeFeedCacheStale,
  patchHomeFeedCache,
  shouldCacheColdHomeFeed,
  writeHomeFeedCache,
  type HomeFeedSnapshot,
} from '@/features/home/store/homeFeedCache';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { useOfflineBrowseContext } from '@/features/offline';
import { useOfflineBrowseReloadToken } from '@/features/offline';
import { useDevOfflineBrowseStore } from '@/features/offline';
import { buildArtistDetailPath } from '@/lib/navigation/detailServerScope';
import { deriveLibraryBrowseScope } from '@/lib/library/libraryBrowseScope';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';
import {
  deriveHomeFeedScope,
  loadHomeChronologicalFeed,
  loadHomeFeedWithStatus,
  loadMoreHomeAlbums,
  patchHomeChronologicalFeed,
  preserveHomeChronologicalFeeds,
  type HomeChronologicalFeedResult,
  type HomeAlbumSection,
} from '@/features/home/pages/homeFeedLoader';
import {
  groupHomeCoverPrefetchBuckets,
  homeDiscoverCoverPrefetchBucket,
  shouldOfferHomeLoadMore,
} from '@/features/home/pages/homeCoverPrefetch';
import MainstageDiagnosticFrame from '@/features/home/components/MainstageDiagnosticFrame';
import {
  MAINSTAGE_DIAGNOSTIC_SECTION_IDS,
  useMainstageDiagnosticStore,
  type MainstageDiagnosticFinish,
  type MainstageDiagnosticStatus,
} from '@/features/home/store/mainstageDiagnosticStore';
import type { HomeSectionId } from '@/features/home/store/homeStore';
import { useLibraryScopeSyncRevision } from '@/store/offlineLocalLibrarySyncRevision';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import {
  homeSnapshotForEnabledCoverWarm,
  preserveDisabledHomeSections,
  reportCachedHomeDiagnostics,
  type MainstageEnabledSections,
} from '@/features/home/pages/homeDiagnosticHelpers';
import { scheduleStartupSplashDismiss } from '@/app/startupSplash';
import { useMigrationStore } from '@/store/migrationStore';

/** Match Random Albums overshoot when mix filter uses album/artist axes so hero + discover row can still fill. */
const HOME_RANDOM_FETCH = 100;
const HOME_DISCOVER_SLICE = 20;
const HOME_ALBUM_ROW_ARTWORK_SIZE = 300;
const HOME_SONG_RAIL_ARTWORK_SIZE = 200;
const HOME_ARTWORK_WINDOWING = true;
// At least one viewport width of cards on first paint (low values left half the row as placeholders).
const HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET = 14;
const HOME_SONG_RAIL_INITIAL_ARTWORK_BUDGET = 16;
const HOME_BECAUSE_CARD_COVER_CSS_PX = 160;
// Keep artwork enabled across Home rows in normal mode.
const HOME_ARTWORK_VISIBLE_ROW_BUDGET_WHEN_ENABLED = 8;

function getInitialHomeFeed(): HomeFeedSnapshot | null {
  const state = useAuthStore.getState();
  const { scopeKey } = deriveHomeFeedScope(state);
  if (!scopeKey) return null;
  return readHomeFeedCache(scopeKey, state.libraryBrowseScopeVersion)
    ?? readHomeFeedCacheStale(scopeKey);
}

export default function Home() {
  const perfFlags = usePerfProbeFlags();
  const homeAlbumRowsDisabled = perfFlags.disableMainstageRails || perfFlags.disableHomeAlbumRows;
  const homeSongRailsDisabled = perfFlags.disableMainstageRails || perfFlags.disableHomeSongRails;
  const homeRailArtworkDisabled = perfFlags.disableMainstageRailArtwork || perfFlags.disableHomeRailArtwork;
  const mainstageDiagnosticsVisible = usePsyLabDebugTraces().mainstage;
  const mainstageDiagnosticsEnabled = usePsyLabDebugTraceEnabled('mainstage');
  const mainstageDiagnosticsRevision = usePsyLabDebugTraceRevision();
  const homeSections = useHomeStore(s => s.sections);
  const diagnosticEnabled = useMainstageDiagnosticStore(useShallow(state => ({
    hero: state.sections.hero.enabled,
    recent: state.sections.recent.enabled,
    becauseYouLike: state.sections.becauseYouLike.enabled,
    discover: state.sections.discover.enabled,
    discoverSongs: state.sections.discoverSongs.enabled,
    discoverArtists: state.sections.discoverArtists.enabled,
    recentlyPlayed: state.sections.recentlyPlayed.enabled,
    starred: state.sections.starred.enabled,
    mostPlayed: state.sections.mostPlayed.enabled,
    losslessAlbums: state.sections.losslessAlbums.enabled,
  })));
  const startDiagnostic = useMainstageDiagnosticStore(s => s.start);
  const finishDiagnostic = useMainstageDiagnosticStore(s => s.finish);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const servers = useAuthStore(s => s.servers);
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const musicFoldersByServer = useAuthStore(s => s.musicFoldersByServer);
  const libraryBrowseSelectionByServer = useAuthStore(s => s.libraryBrowseSelectionByServer);
  const scopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const unavailableServerIds = useUnavailableServerIds();
  const { serverIds, scopeKey } = useMemo(() => deriveHomeFeedScope({
    servers,
    activeServerId,
    libraryBrowseServerIds,
    libraryBrowseSelectionByServer,
  }, unavailableServerIds), [
    activeServerId,
    libraryBrowseSelectionByServer,
    libraryBrowseServerIds,
    servers,
    unavailableServerIds,
  ]);
  const { anchorServerId, pairs: scopes } = useMemo(
    () => deriveLibraryBrowseScope({
      servers,
      activeServerId,
      libraryBrowseServerIds,
      musicFoldersByServer,
      libraryBrowseSelectionByServer,
    }, unavailableServerIds),
    [
      activeServerId,
      libraryBrowseSelectionByServer,
      libraryBrowseServerIds,
      musicFoldersByServer,
      servers,
      unavailableServerIds,
    ],
  );
  const connStatus = useConnectionStatus().status;
  const migrationReady = useMigrationStore(s => s.phase === 'completed');
  const devForceOffline = useDevOfflineBrowseStore(s => s.forceOffline);
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  const librarySyncRevision = useLibraryScopeSyncRevision(serverIds);
  // Re-run the home feed once the local index becomes ready: the chronological
  // (recent / recentlyPlayed) loaders gate on `readyLibraryServerKeys`, whose only
  // reactive input is masterEnabled. Without this dep the feed loads once at mount
  // while masterEnabled is still false and never retriggers -> empty New/Latest rails.
  const libraryMasterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const isVisible = (id: string) => homeSections.find(s => s.id === id)?.visible ?? true;
  const sectionEnabled = (id: HomeSectionId) => (
    isVisible(id) && (!mainstageDiagnosticsEnabled || diagnosticEnabled[id])
  );
  const getEffectiveEnabledSections = (): MainstageEnabledSections => Object.fromEntries(
    MAINSTAGE_DIAGNOSTIC_SECTION_IDS.map(id => [id, sectionEnabled(id)]),
  ) as MainstageEnabledSections;

  const [initialFeed] = useState(getInitialHomeFeed);
  const [starred, setStarred] = useState<SubsonicAlbum[]>(initialFeed?.starred ?? []);
  const [recent, setRecent] = useState<SubsonicAlbum[]>(initialFeed?.recent ?? []);
  const [random, setRandom] = useState<SubsonicAlbum[]>(initialFeed?.random ?? []);
  const [heroAlbums, setHeroAlbums] = useState<SubsonicAlbum[]>(initialFeed?.heroAlbums ?? []);
  const [mostPlayed, setMostPlayed] = useState<SubsonicAlbum[]>(initialFeed?.mostPlayed ?? []);
  const [recentlyPlayed, setRecentlyPlayed] = useState<SubsonicAlbum[]>(initialFeed?.recentlyPlayed ?? []);
  const [randomArtists, setRandomArtists] = useState<SubsonicArtist[]>(initialFeed?.randomArtists ?? []);
  const [discoverSongs, setDiscoverSongs] = useState<SubsonicSong[]>(initialFeed?.discoverSongs ?? []);
  const [recentHasMore, setRecentHasMore] = useState(initialFeed?.offsets.recent.hasMore ?? false);
  const [recentlyPlayedHasMore, setRecentlyPlayedHasMore] = useState(
    initialFeed?.offsets.recentlyPlayed.hasMore ?? false,
  );
  const [loading, setLoading] = useState(initialFeed == null);
  const displayedSnapshotRef = useRef<HomeFeedSnapshot | null>(initialFeed);
  const feedLoadVersionRef = useRef(0);
  const appliedSyncRevisionRef = useRef(librarySyncRevision);
  const previousConnStatusRef = useRef(connStatus);
  const activeScopeRef = useRef({ scopeKey, scopeVersion });

  useLayoutEffect(() => {
    activeScopeRef.current = { scopeKey, scopeVersion };
  }, [scopeKey, scopeVersion]);

  useEffect(() => {
    const canLoadFeed = serverIds.length > 0 && !!scopeKey && !!anchorServerId;
    if (loading && canLoadFeed) return;
    scheduleStartupSplashDismiss();
  }, [anchorServerId, loading, scopeKey, serverIds.length]);

  const applyFeedSnapshot = (snap: HomeFeedSnapshot) => {
    displayedSnapshotRef.current = snap;
    setStarred(snap.starred);
    setRecent(snap.recent);
    setRandom(snap.random);
    setHeroAlbums(snap.heroAlbums);
    setMostPlayed(snap.mostPlayed);
    setRecentlyPlayed(snap.recentlyPlayed);
    setRandomArtists(snap.randomArtists);
    setDiscoverSongs(snap.discoverSongs);
    setRecentHasMore(snap.offsets.recent.hasMore);
    setRecentlyPlayedHasMore(snap.offsets.recentlyPlayed.hasMore);
  };

  useEffect(() => {
    bumpPerfCounter('homeCommits');
  });

  useLibraryCoverPrefetch(
    groupHomeCoverPrefetchBuckets([
      { albums: sectionEnabled('hero') ? heroAlbums : [], priority: 'high' },
      { albums: sectionEnabled('recent') ? recent : [], priority: 'high' },
      {
        albums: [
          ...(sectionEnabled('discover') ? random : []),
          ...(sectionEnabled('mostPlayed') ? mostPlayed : []),
          ...(sectionEnabled('recentlyPlayed') ? recentlyPlayed : []),
          ...(sectionEnabled('starred') ? starred : []),
        ],
        artists: sectionEnabled('discoverArtists') ? randomArtists : [],
        limit: 24,
        priority: 'low',
      },
      homeDiscoverCoverPrefetchBucket(sectionEnabled('discoverSongs') ? discoverSongs : []),
    ]),
    [
      heroAlbums, recent, random, mostPlayed, recentlyPlayed, starred, randomArtists,
      discoverSongs, servers, diagnosticEnabled, homeSections, mainstageDiagnosticsEnabled,
    ],
  );

  useEffect(() => {
    void mainstageDiagnosticsRevision;
    if (!mainstageDiagnosticsEnabled) return;
    const displayed = displayedSnapshotRef.current;
    if (!displayed || displayed.scopeKey !== scopeKey || displayed.scopeVersion !== scopeVersion) return;
    reportCachedHomeDiagnostics(
      displayed,
      id => (homeSections.find(section => section.id === id)?.visible ?? true) && diagnosticEnabled[id],
      finishDiagnostic,
    );
  }, [
    diagnosticEnabled,
    finishDiagnostic,
    homeSections,
    mainstageDiagnosticsEnabled,
    mainstageDiagnosticsRevision,
    scopeKey,
    scopeVersion,
  ]);

  useEffect(() => {
    if (!migrationReady || serverIds.length === 0 || !scopeKey || !anchorServerId) return;
    let cancelled = false;
    const loadVersion = ++feedLoadVersionRef.current;
    const isCurrentLoad = () => !cancelled && feedLoadVersionRef.current === loadVersion;
    const syncRefresh = appliedSyncRevisionRef.current !== librarySyncRevision;
    appliedSyncRevisionRef.current = librarySyncRevision;
    const reconnectRefresh = previousConnStatusRef.current !== 'connected' && connStatus === 'connected';
    previousConnStatusRef.current = connStatus;
    const startFreshHomeFeed = () => {
      const mixCfg = getMixMinRatingsConfigFromAuth();
      const albumMix =
        mixCfg.enabled && (mixCfg.minAlbum > 0 || mixCfg.minArtist > 0);
      const randomSize = albumMix ? HOME_RANDOM_FETCH : HOME_DISCOVER_SLICE;
      const feed = loadHomeFeedWithStatus({
        serverIds,
        scopeKey,
        anchorServerId,
        scopes,
        scopeVersion,
        syncRevision: librarySyncRevision,
        randomSize,
        showArtists: sectionEnabled('discoverArtists'),
        showSongs: sectionEnabled('discoverSongs'),
        enabledSections: {
          hero: sectionEnabled('hero'),
          discover: sectionEnabled('discover'),
          discoverArtists: sectionEnabled('discoverArtists'),
          discoverSongs: sectionEnabled('discoverSongs'),
          starred: sectionEnabled('starred'),
          mostPlayed: sectionEnabled('mostPlayed'),
        },
        onSectionResult: (section, result) => {
          if (!mainstageDiagnosticsEnabled || result.status === 'disabled' || !isCurrentLoad()) return;
          finishDiagnostic(section, {
            status: result.itemCount > 0 ? 'ready' : 'empty',
            durationMs: result.durationMs,
            itemCount: result.itemCount,
            detail: result.detail,
          });
        },
        mixConfig: mixCfg,
        deps: { filterAlbumsByMixRatingsAcrossServers },
      });
      for (const section of ['hero', 'discover', 'discoverArtists', 'discoverSongs', 'starred', 'mostPlayed'] as const) {
        if (mainstageDiagnosticsEnabled && sectionEnabled(section)) startDiagnostic(section);
      }
      const chronological = {
        recent: sectionEnabled('recent')
          ? loadHomeChronologicalFeed({
              anchorServerId,
              serverIds,
              scopes,
              feed: 'newReleases',
              freshness: librarySyncRevision,
            })
          : null,
        recentlyPlayed: sectionEnabled('recentlyPlayed')
          ? loadHomeChronologicalFeed({
              anchorServerId,
              serverIds,
              scopes,
              feed: 'recentlyPlayed',
              freshness: librarySyncRevision,
            })
          : null,
      };
      if (mainstageDiagnosticsEnabled && chronological.recent) startDiagnostic('recent');
      if (mainstageDiagnosticsEnabled && chronological.recentlyPlayed) startDiagnostic('recentlyPlayed');
      return { feed, chronological };
    };
    const applyChronologicalResult = (
      section: 'recent' | 'recentlyPlayed',
      result: HomeChronologicalFeedResult,
      applyToDisplay = true,
    ) => {
      if (result.status !== 'success' || !isCurrentLoad()) return;
      const displayed = displayedSnapshotRef.current;
      if (displayed?.scopeKey !== scopeKey || displayed.scopeVersion !== scopeVersion) return;
      patchHomeFeedCache(scopeKey, scopeVersion, snapshot => (
        patchHomeChronologicalFeed(snapshot, section, result)
      ));
      if (applyToDisplay) applyFeedSnapshot(patchHomeChronologicalFeed(displayed, section, result));
      if (mainstageDiagnosticsEnabled) finishDiagnostic(section, {
        status: result.albums.length > 0 ? 'ready' : 'empty',
        durationMs: result.durationMs,
        itemCount: result.albums.length,
      });
    };
    const patchChronologicalFeeds = (
      chronological: ReturnType<typeof startFreshHomeFeed>['chronological'],
      applyToDisplay = true,
    ) => {
      const pending: Promise<void>[] = [];
      if (chronological.recent) {
        pending.push(chronological.recent.then(result => {
            if (mainstageDiagnosticsEnabled && result.status !== 'success' && isCurrentLoad()) finishDiagnostic('recent', {
            status: result.status,
            durationMs: result.durationMs,
            itemCount: 0,
            detail: result.status === 'error' ? result.detail : undefined,
          });
          applyChronologicalResult('recent', result, applyToDisplay);
        }));
      }
      if (chronological.recentlyPlayed) {
        pending.push(chronological.recentlyPlayed.then(result => {
            if (mainstageDiagnosticsEnabled && result.status !== 'success' && isCurrentLoad()) finishDiagnostic('recentlyPlayed', {
            status: result.status,
            durationMs: result.durationMs,
            itemCount: 0,
            detail: result.status === 'error' ? result.detail : undefined,
          });
          applyChronologicalResult('recentlyPlayed', result, applyToDisplay);
        }));
      }
      return Promise.all(pending).then(() => undefined);
    };

    const cached = readHomeFeedCache(scopeKey, scopeVersion)
      ?? (offlineBrowseActive ? readHomeFeedCacheStale(scopeKey) : null);
    if (cached) {
      if (displayedSnapshotRef.current !== cached) applyFeedSnapshot(cached);
      if (mainstageDiagnosticsEnabled) {
        reportCachedHomeDiagnostics(cached, sectionEnabled, finishDiagnostic);
      }
      // React Compiler set-state-in-effect rule: cache synchronization within this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      const effectiveEnabled = getEffectiveEnabledSections();
      void warmHomeMainstageCovers(homeSnapshotForEnabledCoverWarm(cached, effectiveEnabled));
      const becauseSnap = readBecauseYouLikeCache(scopeKey, scopeVersion);
      if (effectiveEnabled.becauseYouLike) {
        void primeAlbumCoversForDisplay(becauseSnap?.recs ?? [], HOME_BECAUSE_CARD_COVER_CSS_PX, {
          limit: 6,
        });
      }
      // Keep this visit stable, but prepare a fresh snapshot so the next visit
      // is instant. Sync/reconnect refreshes also update the currently visible feed.
      if (!offlineBrowseActive || syncRefresh || reconnectRefresh) {
        void (async () => {
          try {
            const freshLoad = startFreshHomeFeed();
            const loaded = await freshLoad.feed;
            if (!isCurrentLoad()) return;
            const fresh = preserveDisabledHomeSections(
              preserveHomeChronologicalFeeds(loaded.snapshot, displayedSnapshotRef.current),
              displayedSnapshotRef.current,
              getEffectiveEnabledSections(),
            );
            if (isHomeFeedSnapshotEmpty(fresh)) return;
            writeHomeFeedCache(fresh);
            const applyCurrentRefresh = syncRefresh || reconnectRefresh;
            if (applyCurrentRefresh) applyFeedSnapshot(fresh);
            void patchChronologicalFeeds(freshLoad.chronological, applyCurrentRefresh);
            void warmHomeMainstageCovers(homeSnapshotForEnabledCoverWarm(
              fresh,
              getEffectiveEnabledSections(),
            ));
          } catch {
            /* ignore */
          }
        })();
      }
      return () => {
        cancelled = true;
      };
    }

    const stale = offlineBrowseActive ? readHomeFeedCacheStale(scopeKey) : null;
    if (stale) {
      applyFeedSnapshot(stale);
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    (async () => {
      try {
        const freshLoad = startFreshHomeFeed();
        const loaded = await freshLoad.feed;
        if (!isCurrentLoad()) return;
        const snap = preserveDisabledHomeSections(
          preserveHomeChronologicalFeeds(loaded.snapshot, displayedSnapshotRef.current),
          displayedSnapshotRef.current,
          getEffectiveEnabledSections(),
        );
        if (offlineBrowseActive && isHomeFeedSnapshotEmpty(snap)) return;
        if (shouldCacheColdHomeFeed(snap, loaded.emptySnapshotReliable, false)) {
          writeHomeFeedCache(snap);
        }
        applyFeedSnapshot(snap);
        if (!cancelled) setLoading(false);
        // New/Latest rails patch in whenever their (independent) query resolves.
        // Do not gate the Hero/loading state on them, and do not discard a correct
        // result just because a busy backend made it late (see chronological timeout).
        void patchChronologicalFeeds(freshLoad.chronological);
        const effectiveEnabled = getEffectiveEnabledSections();
        void warmHomeMainstageCovers(homeSnapshotForEnabledCoverWarm(snap, effectiveEnabled));
        const becauseSnap = readBecauseYouLikeCache(scopeKey, scopeVersion);
        if (effectiveEnabled.becauseYouLike) {
          void primeAlbumCoversForDisplay(becauseSnap?.recs ?? [], HOME_BECAUSE_CARD_COVER_CSS_PX, {
            limit: 6,
          });
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scopeKey,
    scopeVersion,
    anchorServerId,
    scopes,
    homeSections,
    diagnosticEnabled,
    mainstageDiagnosticsEnabled,
    offlineBrowseActive,
    offlineBrowseReloadTs,
    librarySyncRevision,
    libraryMasterEnabled,
    migrationReady,
    connStatus,
  ]);

  /** When offline toggles without a library-filter bump, re-apply stale cache if the feed was cleared. */
  useEffect(() => {
    if (!scopeKey || !offlineBrowseActive) return;
    const stale = readHomeFeedCacheStale(scopeKey);
    if (!stale || isHomeFeedSnapshotEmpty(stale)) return;
    if (recent.length > 0 || random.length > 0 || heroAlbums.length > 0) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyFeedSnapshot(stale);
    setLoading(false);
  }, [scopeKey, connStatus, devForceOffline, offlineBrowseActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async (section: HomeAlbumSection) => {
    const current = displayedSnapshotRef.current;
    if (!current || !anchorServerId) return;
    if (current.scopeKey !== scopeKey || current.scopeVersion !== scopeVersion) return;
    const requestedScope = { scopeKey, scopeVersion };
    const sectionAlbums = current[section];
    const sectionOffset = current.offsets[section];
    try {
      const next = await loadMoreHomeAlbums({
        snapshot: current,
        section,
        anchorServerId,
        serverIds,
        scopes,
        mixConfig: getMixMinRatingsConfigFromAuth(),
        deps: { filterAlbumsByMixRatingsAcrossServers },
      });
      const activeScope = activeScopeRef.current;
      if (
        activeScope.scopeKey !== requestedScope.scopeKey
        || activeScope.scopeVersion !== requestedScope.scopeVersion
      ) return;
      const displayed = displayedSnapshotRef.current;
      if (
        !displayed
        || displayed.scopeKey !== requestedScope.scopeKey
        || displayed.scopeVersion !== requestedScope.scopeVersion
        || displayed[section] !== sectionAlbums
        || displayed.offsets[section] !== sectionOffset
      ) return;
      const merged: HomeFeedSnapshot = {
        ...displayed,
        savedAt: next.savedAt,
        offsets: { ...displayed.offsets, [section]: next.offsets[section] },
        [section]: next[section],
      };
      writeHomeFeedCache(merged);
      applyFeedSnapshot(merged);
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

  const reportAutonomousDiagnostic = (
    section: 'becauseYouLike' | 'losslessAlbums',
    result: {
      status: Exclude<MainstageDiagnosticStatus, 'idle' | 'disabled'>;
      durationMs?: number;
      itemCount?: number;
      detail?: string;
    },
  ) => {
    if (result.status === 'loading') {
      startDiagnostic(section, result.detail);
      return;
    }
    finishDiagnostic(section, result as MainstageDiagnosticFinish);
  };

  const copyAllMainstageDiagnostics = async () => {
    const labels: Record<HomeSectionId, string> = {
      hero: t('home.hero'),
      recent: t('sidebar.newReleases'),
      becauseYouLike: t('home.becauseYouLike'),
      discover: t('home.discover'),
      discoverSongs: t('home.discoverSongs'),
      discoverArtists: t('home.discoverArtists'),
      recentlyPlayed: t('home.recentlyPlayed'),
      starred: t('home.starred'),
      mostPlayed: t('home.mostPlayed'),
      losslessAlbums: t('home.losslessAlbums'),
    };
    const sections = useMainstageDiagnosticStore.getState().sections;
    const text = MAINSTAGE_DIAGNOSTIC_SECTION_IDS.map(id => {
      const section = sections[id];
      return [
        `mainstage section: ${id} (${labels[id]})`,
        `status: ${section.status}`,
        `durationMs: ${section.durationMs ?? 'n/a'}`,
        `itemCount: ${section.itemCount ?? 'n/a'}`,
        `enabled: ${section.enabled}`,
        `detail: ${section.detail ?? 'n/a'}`,
      ].join('\n');
    }).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access may be unavailable in an embedded webview permission state.
    }
  };

  useEffect(() => {
    if (!mainstageDiagnosticsEnabled || loading || !sectionEnabled('becauseYouLike') || becauseYouLikeHasSeed) return;
    finishDiagnostic('becauseYouLike', {
      status: 'empty',
      durationMs: 0,
      itemCount: 0,
      detail: 'no seed albums',
    });
    // sectionEnabled is derived from the explicit dependencies below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, becauseYouLikeHasSeed, diagnosticEnabled.becauseYouLike, homeSections, mainstageDiagnosticsEnabled, finishDiagnostic]);

  const homeLiteArtworkFx = perfFlags.disableHomeArtworkFx;
  const homeFlatArtworkClip = perfFlags.disableHomeArtworkClip;
  // Treat the library as empty when every album endpoint returned zero. The
  // song/artist rails can be empty for non-empty libraries (rare server quirks),
  // so they don't count toward this signal.
  // Every section toggled off in Settings → Personalisation → Mainstage. The
  // page would otherwise be entirely blank, so surface a guided empty state
  // pointing back at the toggles (or the option to hide Mainstage from the
  // sidebar) instead of leaving the user on nothing.
  const allSectionsHidden = homeSections.every(s => !s.visible);
  return (
    <div
      className={[
        homeLiteArtworkFx ? 'home-lite-artwork' : '',
        homeFlatArtworkClip ? 'home-flat-artwork-clip' : '',
      ].filter(Boolean).join(' ') || undefined}
    >
      {mainstageDiagnosticsVisible && <div className="mainstage-diagnostic-copy-all">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void copyAllMainstageDiagnostics()}
        >
          {t('home.diagnostics.copyAll')}
        </button>
      </div>}
      {!perfFlags.disableMainstageHero && isVisible('hero') && (
        <MainstageDiagnosticFrame sectionId="hero" label={t('home.hero')} active={mainstageDiagnosticsVisible}>
          {!loading && <Hero albums={heroAlbums} />}
        </MainstageDiagnosticFrame>
      )}

      <div className="content-body" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
        {allSectionsHidden ? (
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
        ) : (
          <>
            {!homeAlbumRowsDisabled && isVisible('recent') && (
              <MainstageDiagnosticFrame sectionId="recent" label={t('sidebar.newReleases')} active={mainstageDiagnosticsVisible}>
                <AlbumRow
                title={t('sidebar.newReleases')}
                titleLink="/new-releases"
                albums={recent}
                onLoadMore={shouldOfferHomeLoadMore(recentHasMore) ? () => loadMore('recent') : undefined}
                moreText={t('home.loadMore')}
                disableArtwork={!recentArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
                />
              </MainstageDiagnosticFrame>
            )}
            {!homeAlbumRowsDisabled && isVisible('becauseYouLike') && (
              <MainstageDiagnosticFrame sectionId="becauseYouLike" label={t('home.becauseYouLike')} active={mainstageDiagnosticsVisible}>
                {becauseYouLikeHasSeed && <BecauseYouLikeRail
                  mostPlayed={mostPlayed}
                  recentlyPlayed={recentlyPlayed}
                  starred={starred}
                  scopeKey={scopeKey}
                  scopeVersion={scopeVersion}
                  scopes={scopes}
                  disableArtwork={!becauseYouLikeArtworkEnabled}
                  onDiagnosticResult={mainstageDiagnosticsEnabled
                    ? result => reportAutonomousDiagnostic('becauseYouLike', result)
                    : undefined}
                />}
              </MainstageDiagnosticFrame>
            )}
            {!homeAlbumRowsDisabled && isVisible('discover') && (
              <MainstageDiagnosticFrame sectionId="discover" label={t('home.discover')} active={mainstageDiagnosticsVisible}>
                <AlbumRow
                title={t('home.discover')}
                titleLink="/random/albums"
                albums={random}
                onLoadMore={() => loadMore('random')}
                moreText={t('home.discoverMore')}
                disableArtwork={!discoverArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
                />
              </MainstageDiagnosticFrame>
            )}
            {!homeSongRailsDisabled && isVisible('discoverSongs') && (
              <MainstageDiagnosticFrame sectionId="discoverSongs" label={t('home.discoverSongs')} active={mainstageDiagnosticsVisible}>
                {discoverSongs.length > 0 && <SongRail
                title={t('home.discoverSongs')}
                songs={discoverSongs}
                disableArtwork={!discoverSongsArtworkEnabled}
                artworkSize={HOME_SONG_RAIL_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_SONG_RAIL_INITIAL_ARTWORK_BUDGET}
                />}
              </MainstageDiagnosticFrame>
            )}
            {!perfFlags.disableMainstageGridCards && isVisible('discoverArtists') && (
              <MainstageDiagnosticFrame sectionId="discoverArtists" label={t('home.discoverArtists')} active={mainstageDiagnosticsVisible}>
                {randomArtists.length > 0 && <section className="album-row-section">
                <div className="album-row-header">
                  <NavLink to="/artists" className="section-title-link" style={{ marginBottom: 0 }}>
                    {t('home.discoverArtists')}<ChevronRight size={18} className="section-title-chevron" />
                  </NavLink>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {randomArtists.map(a => (
                    <button
                      key={`${a.serverId ?? ''}:${a.id}`}
                      className="artist-ext-link"
                      onClick={() => {
                        navigate(buildArtistDetailPath(a.id, { serverId: a.serverId }));
                      }}
                    >
                      {a.name}
                    </button>
                  ))}
                  <button className="artist-ext-link" onClick={() => navigate('/artists')}
                    style={{ opacity: 0.6 }}>
                    {t('home.discoverArtistsMore')} →
                  </button>
                </div>
                </section>}
              </MainstageDiagnosticFrame>
            )}
            {!homeAlbumRowsDisabled && isVisible('recentlyPlayed') && (
              <MainstageDiagnosticFrame sectionId="recentlyPlayed" label={t('home.recentlyPlayed')} active={mainstageDiagnosticsVisible}>
                <AlbumRow
                title={t('home.recentlyPlayed')}
                albums={recentlyPlayed}
                onLoadMore={shouldOfferHomeLoadMore(recentlyPlayedHasMore)
                  ? () => loadMore('recentlyPlayed')
                  : undefined}
                moreText={t('home.loadMore')}
                disableArtwork={!recentlyPlayedArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
                />
              </MainstageDiagnosticFrame>
            )}
            {!homeAlbumRowsDisabled && isVisible('starred') && (
              <MainstageDiagnosticFrame sectionId="starred" label={t('home.starred')} active={mainstageDiagnosticsVisible}>
                <AlbumRow
                title={t('home.starred')}
                titleLink="/favorites"
                albums={starred}
                onLoadMore={() => loadMore('starred')}
                moreText={t('home.loadMore')}
                disableArtwork={!starredArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
                />
              </MainstageDiagnosticFrame>
            )}
            {!homeAlbumRowsDisabled && isVisible('mostPlayed') && (
              <MainstageDiagnosticFrame sectionId="mostPlayed" label={t('home.mostPlayed')} active={mainstageDiagnosticsVisible}>
                <AlbumRow
                title={t('home.mostPlayed')}
                titleLink="/most-played"
                albums={mostPlayed}
                onLoadMore={() => loadMore('mostPlayed')}
                moreText={t('home.loadMore')}
                disableArtwork={!mostPlayedArtworkEnabled}
                artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
                />
              </MainstageDiagnosticFrame>
            )}
            {!homeAlbumRowsDisabled && isVisible('losslessAlbums') && (
              <MainstageDiagnosticFrame sectionId="losslessAlbums" label={t('home.losslessAlbums')} active={mainstageDiagnosticsVisible}>
                <LosslessAlbumsRail
                  serverIds={serverIds}
                  scopeVersion={scopeVersion}
                  scopes={scopes}
                  disableArtwork={!losslessAlbumsArtworkEnabled}
                  artworkSize={HOME_ALBUM_ROW_ARTWORK_SIZE}
                  windowArtworkByViewport={HOME_ARTWORK_WINDOWING}
                  initialArtworkBudget={HOME_ALBUM_ROW_INITIAL_ARTWORK_BUDGET}
                  onDiagnosticResult={mainstageDiagnosticsEnabled
                    ? result => reportAutonomousDiagnostic('losslessAlbums', result)
                    : undefined}
                />
              </MainstageDiagnosticFrame>
            )}
          </>
        )}
      </div>
    </div>
  );
}
