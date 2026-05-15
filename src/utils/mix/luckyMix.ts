import { getSimilarSongs } from '../../api/subsonicArtists';
import { filterSongsToActiveLibrary, getRandomSongs } from '../../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicSong } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import { songToTrack } from '../playback/songToTrack';
import { invoke } from '@tauri-apps/api/core';
import i18n from '../../i18n';
import { useAuthStore } from '../../store/authStore';
import { pushQueueUndoFromGetter } from '../../store/queueUndo';
import { usePlayerStore } from '../../store/playerStore';
import { useLuckyMixStore } from '../../store/luckyMixStore';
import { isLuckyMixAvailable } from '../../hooks/useLuckyMixAvailable';
import { showToast } from '../ui/toast';
import {
  filterSongsForLuckyMixRatings,
  filterTopArtistsForMixRatings,
  getMixMinRatingsConfigFromAuth,
} from './mixRatingFilter';
import {
  MIX_TARGET_SIZE,
  SEED_TARGET_SIZE,
  sampleRandom,
  uniqueBySongId,
  uniqueAppend,
  deriveTopArtistsFromFrequentAlbums,
  fetchFrequentAlbumsPool,
  pickSongsForArtist,
  pickSongsForAlbum,
  pickGoodRatedSongs,
} from './luckyMixHelpers';

/**
 * Sentinel thrown inside the build loop when `useLuckyMixStore.cancelRequested`
 * flips to true. The `catch` handler swallows it silently (no toast, no
 * queue restore, no error state) — the user already moved on.
 */
class LuckyMixCancelled extends Error {
  constructor() {
    super('lucky-mix-cancelled');
    this.name = 'LuckyMixCancelled';
  }
}

export async function buildAndPlayLuckyMix(): Promise<void> {
  const lucky = useLuckyMixStore.getState();
  if (lucky.isRolling) return;
  const auth = useAuthStore.getState();
  const debugEnabled = auth.loggingMode === 'debug';
  const debugSteps: Array<{ step: string; details?: unknown }> = [];
  const logStep = (step: string, details?: unknown) => {
    if (!debugEnabled) return;
    const payload = { step, details };
    debugSteps.push(payload);
    console.debug('[psysonic][lucky-mix]', payload);
    void invoke('frontend_debug_log', {
      scope: 'lucky-mix',
      message: JSON.stringify(payload),
    }).catch(() => {});
  };
  const songDebug = (songs: SubsonicSong[]) =>
    songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, rating: s.userRating ?? 0 }));
  const albumDebug = (albums: SubsonicAlbum[]) =>
    albums.map(a => ({ id: a.id, name: a.name, artist: a.artist, playCount: a.playCount ?? 0 }));
  const activeServerId = auth.activeServerId;
  const available = isLuckyMixAvailable({
    activeServerId,
    audiomuseByServer: auth.audiomuseNavidromeByServer,
    showLuckyMixMenu:  auth.showLuckyMixMenu,
  });
  const mixRatingCfg = getMixMinRatingsConfigFromAuth();
  logStep('init', {
    activeServerId,
    available,
    showLuckyMixMenu: auth.showLuckyMixMenu,
    libraryFilter: activeServerId ? (auth.musicLibraryFilterByServer[activeServerId] ?? 'all') : 'all',
    mixRatingFilter: mixRatingCfg,
  });
  if (!available) {
    logStep('abort_unavailable');
    showToast(i18n.t('luckyMix.unavailable'), 4000, 'warning');
    return;
  }

  // Snapshot the current queue *before* we prune — so if the build fails
  // before we ever play a track, we can put it back the way it was instead
  // of leaving the user with an empty player.
  const playerStateBefore = usePlayerStore.getState();
  const queueSnapshot: { queue: Track[]; queueIndex: number } = {
    queue: [...playerStateBefore.queue],
    queueIndex: playerStateBefore.queueIndex,
  };

  // One undo step for the whole Lucky Mix run — internal prune/play/enqueue
  // batches must not each push (QUEUE_UNDO_MAX would drop this snapshot).
  pushQueueUndoFromGetter(() => usePlayerStore.getState());

  let unsubPlayer: (() => void) | null = null;
  try {
    // Drop the old "upcoming" tail immediately so the queue UI does not show stale
    // next tracks while the mix is still building (first playTrack may be delayed).
    usePlayerStore.getState().pruneUpcomingToCurrent(true);

    lucky.start();
    let startedPlayback = false;
    try {
      let allSeedSongs: SubsonicSong[] = [];

    const mixQueueSize = () => usePlayerStore.getState().queue.length;
    const mixQueueTrackIds = () => new Set(usePlayerStore.getState().queue.map(t => t.id));

    const bailIfCancelled = () => {
      if (useLuckyMixStore.getState().cancelRequested) throw new LuckyMixCancelled();
    };
    const reachedTarget = () => mixQueueSize() >= MIX_TARGET_SIZE;

    const startImmediatePlayback = async (song: SubsonicSong, source: string) => {
      if (startedPlayback || !song?.id) return;
      const allowed = await filterSongsForLuckyMixRatings([song], mixRatingCfg);
      if (!allowed.length) return;
      const play = allowed[0];
      startedPlayback = true;
      const track = songToTrack(play);
      usePlayerStore.getState().playTrack(track, [track], false);
      logStep('start_immediate_playback', {
        source,
        song: songDebug([play])[0],
        queuedCount: mixQueueSize(),
      });

      // Auto-cancel: once we're playing, watch the player store. If the
      // current track switches to something the user picked themselves (not
      // in the mix queue), treat that as "user moved on" and cancel the build.
      if (!unsubPlayer) {
        unsubPlayer = usePlayerStore.subscribe((state, prev) => {
          const prevId = prev.currentTrack?.id ?? null;
          const nextId = state.currentTrack?.id ?? null;
          if (nextId === prevId) return;
          if (!nextId) return;
          if (state.queue.some(t => t.id === nextId)) return;
          useLuckyMixStore.getState().cancel();
        });
      }
    };

    const appendSongsToQueue = async (songs: SubsonicSong[], reason: string): Promise<number> => {
      if (useLuckyMixStore.getState().cancelRequested) return 0;
      if (reachedTarget()) return 0;
      if (!songs.length) return 0;
      const knownIds = mixQueueTrackIds();
      const unique = uniqueBySongId(songs).filter(s => !knownIds.has(s.id));
      const deduped = await filterSongsForLuckyMixRatings(unique, mixRatingCfg);
      if (!deduped.length) return 0;

      const candidates = [...deduped];
      if (!startedPlayback && candidates.length > 0) {
        const first = candidates.shift();
        if (first) await startImmediatePlayback(first, reason);
      }

      if (!candidates.length) return 0;
      const remaining = Math.max(0, MIX_TARGET_SIZE - mixQueueSize());
      if (remaining <= 0) return 0;
      const toAdd = sampleRandom(candidates, Math.min(remaining, candidates.length));
      if (!toAdd.length) return 0;
      const before = mixQueueSize();
      usePlayerStore.getState().enqueue(toAdd.map(songToTrack), true, true);
      const added = mixQueueSize() - before;
      logStep('append_queue_batch', {
        reason,
        added,
        queuedCount: mixQueueSize(),
        songs: songDebug(toAdd),
      });
      return added;
    };

    const frequentAlbums = await fetchFrequentAlbumsPool();
    bailIfCancelled();
    const albumsWithPlays = frequentAlbums.filter(a => (a.playCount ?? 0) > 0);
    logStep('fetch_frequent_albums', {
      fetched: frequentAlbums.length,
      withPlays: albumsWithPlays.length,
    });
    const topArtists = await filterTopArtistsForMixRatings(
      deriveTopArtistsFromFrequentAlbums(albumsWithPlays),
      mixRatingCfg,
    );
    const pickedArtists = sampleRandom(topArtists, 2);
    logStep('pick_top_artists', {
      topArtistsCount: topArtists.length,
      pickedArtists,
    });

    for (const artist of pickedArtists) {
      bailIfCancelled();
      const songs = await pickSongsForArtist(artist, 3, mixRatingCfg);
      allSeedSongs = uniqueAppend(allSeedSongs, songs);
      const firstPlayable = songs[0];
      if (firstPlayable) await startImmediatePlayback(firstPlayable, `artist:${artist.name}`);
      logStep('pick_artist_songs', {
        artist,
        pickedCount: songs.length,
        songs: songDebug(songs),
      });
    }

    const pickedAlbums = sampleRandom(albumsWithPlays, 2);
    logStep('pick_top_albums', {
      poolCount: albumsWithPlays.length,
      pickedAlbums: albumDebug(pickedAlbums),
    });
    for (const album of pickedAlbums) {
      bailIfCancelled();
      const songs = await pickSongsForAlbum(album.id, 3, mixRatingCfg);
      allSeedSongs = uniqueAppend(allSeedSongs, songs);
      const firstPlayable = songs[0];
      if (firstPlayable) await startImmediatePlayback(firstPlayable, `album:${album.id}`);
      logStep('pick_album_songs', {
        albumId: album.id,
        pickedCount: songs.length,
        songs: songDebug(songs),
      });
    }

    bailIfCancelled();
    const rated = await pickGoodRatedSongs(new Set(allSeedSongs.map(s => s.id)), 3, mixRatingCfg);
    logStep('pick_rated_songs_4plus_only', {
      ratedPickedCount: rated.length,
      ratedSongs: songDebug(rated),
    });
    allSeedSongs = uniqueAppend(allSeedSongs, rated);
    let seeds = await filterSongsForLuckyMixRatings(allSeedSongs, mixRatingCfg);
    logStep('seed_after_dedup', {
      seedCount: seeds.length,
      seeds: songDebug(seeds),
    });

    if (seeds.length < SEED_TARGET_SIZE) {
      logStep('seed_fill_start', { target: SEED_TARGET_SIZE, before: seeds.length });
      for (let i = 0; i < 10 && seeds.length < SEED_TARGET_SIZE; i++) {
        bailIfCancelled();
        const rnd = await filterSongsToActiveLibrary(await getRandomSongs(80));
        const allowedRnd = await filterSongsForLuckyMixRatings(rnd, mixRatingCfg);
        seeds = uniqueAppend(seeds, allowedRnd);
        const firstPlayable = allowedRnd[0];
        if (firstPlayable) await startImmediatePlayback(firstPlayable, `seed-fill-batch:${i + 1}`);
        logStep('seed_fill_batch', {
          batch: i + 1,
          fetched: rnd.length,
          seedCount: seeds.length,
        });
      }
      seeds = seeds.slice(0, SEED_TARGET_SIZE);
      logStep('seed_fill_end', {
        finalSeedCount: seeds.length,
        seeds: songDebug(seeds),
      });
    }

    if (seeds.length === 0) {
      throw new Error('no-seeds');
    }
    if (!startedPlayback) {
      const firstPlayableSeed = seeds[0];
      if (firstPlayableSeed) await startImmediatePlayback(firstPlayableSeed, 'seed-fallback-first');
    }

    let similarRaw: SubsonicSong[] = [];
    let similar: SubsonicSong[] = [];
    for (let i = 0; i < seeds.length; i++) {
      bailIfCancelled();
      const seed = seeds[i];
      const oneRaw = await getSimilarSongs(seed.id, 60).catch(() => [] as SubsonicSong[]);
      const oneScoped = await filterSongsToActiveLibrary(oneRaw);
      similarRaw = uniqueAppend(similarRaw, oneRaw);
      similar = uniqueAppend(similar, oneScoped);
      await appendSongsToQueue(oneScoped, `similar-seed-${i + 1}/${seeds.length}`);
      if (reachedTarget()) break;
    }
    const seedForPool = seeds.filter(() => Math.random() < 0.5);
    let pool = uniqueBySongId([...seedForPool, ...similar]);
    await appendSongsToQueue(seedForPool, 'seed-50pct');
    logStep('instant_mix', {
      seedUsedForInstantMixCount: seeds.length,
      seedIncludedInPoolCount: seedForPool.length,
      seedIncludedInPool: songDebug(seedForPool),
      similarRawCount: similarRaw.length,
      similarScopedCount: similar.length,
      initialPoolCount: pool.length,
    });

    const poolFillMaxBatches = mixRatingCfg.enabled ? 25 : 10;
    for (let i = 0; i < poolFillMaxBatches && !reachedTarget(); i++) {
      bailIfCancelled();
      const rnd = await filterSongsToActiveLibrary(await getRandomSongs(120));
      pool = uniqueAppend(pool, rnd);
      await appendSongsToQueue(rnd, `pool-fill-${i + 1}`);
      logStep('pool_fill_batch', {
        batch: i + 1,
        fetched: rnd.length,
        poolCount: pool.length,
        queueCount: mixQueueSize(),
      });
    }

    bailIfCancelled();
    if (!reachedTarget()) {
      const poolFiltered = await filterSongsForLuckyMixRatings(pool, mixRatingCfg);
      const need = MIX_TARGET_SIZE - mixQueueSize();
      const finalSongs = sampleRandom(
        poolFiltered.filter(s => !mixQueueTrackIds().has(s.id)),
        need,
      );
      await appendSongsToQueue(finalSongs, 'finalize-randomized');
    }

    for (let i = 0; i < 20 && !reachedTarget(); i++) {
      bailIfCancelled();
      const rnd = await filterSongsToActiveLibrary(await getRandomSongs(120));
      const added = await appendSongsToQueue(rnd, `topup-${i + 1}`);
      if (added === 0 && i >= 8) break;
    }

    const finalQueueCount = mixQueueSize();
    logStep('final_queue_state', {
      poolCount: pool.length,
      queuedCount: finalQueueCount,
      queuedTarget: MIX_TARGET_SIZE,
    });
    if (finalQueueCount === 0) {
      throw new Error('empty-mix');
    }
    showToast(i18n.t('luckyMix.done', { count: finalQueueCount }), 3500, 'success');
    logStep('done', { queueCount: finalQueueCount });
    if (debugEnabled) {
      console.debug('[psysonic][lucky-mix] full-steps', debugSteps);
      void invoke('frontend_debug_log', {
        scope: 'lucky-mix',
        message: JSON.stringify({ step: 'full-steps', details: debugSteps }),
      }).catch(() => {});
    }
  } catch (err) {
    // Cancellation is a user-initiated path, not an error. Silent teardown.
    if (err instanceof LuckyMixCancelled) {
      logStep('cancelled');
      if (debugEnabled) {
        console.debug('[psysonic][lucky-mix] full-steps', debugSteps);
        void invoke('frontend_debug_log', {
          scope: 'lucky-mix',
          message: JSON.stringify({ step: 'full-steps', details: debugSteps }),
        }).catch(() => {});
      }
      return;
    }
    console.error('[psysonic] lucky mix failed:', err);
    logStep('failed', { error: String(err) });
    if (debugEnabled) {
      console.debug('[psysonic][lucky-mix] full-steps', debugSteps);
      void invoke('frontend_debug_log', {
        scope: 'lucky-mix',
        message: JSON.stringify({ step: 'full-steps', details: debugSteps }),
      }).catch(() => {});
    }
    // If we failed before ever calling playTrack, the queue-prune we did up
    // front left the user with nothing. Restore the snapshot so they land
    // back where they were pre-click instead of in an empty player.
    // If playback did start, leave it alone — their current track plus
    // whatever we managed to enqueue is more useful than the old queue.
    if (!startedPlayback) {
      usePlayerStore.setState({
        queue: queueSnapshot.queue,
        queueIndex: queueSnapshot.queueIndex,
      });
      logStep('queue_restored_after_failure', {
        restoredCount: queueSnapshot.queue.length,
      });
    }
    showToast(i18n.t('luckyMix.failed'), 5000, 'error');
  }
  } finally {
    if (unsubPlayer) { try { unsubPlayer(); } catch { /* noop */ } }
    useLuckyMixStore.getState().stop();
  }
}
