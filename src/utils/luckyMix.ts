import type { Track } from '../store/playerStoreTypes';
import { songToTrack } from '../utils/songToTrack';
import {
  filterSongsToActiveLibrary,
  getAlbum,
  getAlbumList,
  getRandomSongs,
  getSimilarSongs,
  getTopSongs,
  type SubsonicAlbum,
  type SubsonicSong,
} from '../api/subsonic';
import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { useLuckyMixStore } from '../store/luckyMixStore';
import { isLuckyMixAvailable } from '../hooks/useLuckyMixAvailable';
import { showToast } from './toast';
import {
  filterSongsForLuckyMixRatings,
  getMixMinRatingsConfigFromAuth,
  type MixMinRatingsConfig,
} from './mixRatingFilter';

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

interface TopArtist {
  id: string;
  name: string;
  totalPlays: number;
}

const MOST_PLAYED_PAGE_SIZE = 100;
const MOST_PLAYED_MAX_ALBUMS = 500;
const MIX_TARGET_SIZE = 50;
const SEED_TARGET_SIZE = 15;

function sampleRandom<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

function uniqueBySongId(items: SubsonicSong[]): SubsonicSong[] {
  const out: SubsonicSong[] = [];
  const seen = new Set<string>();
  for (const s of items) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

function uniqueAppend(base: SubsonicSong[], incoming: SubsonicSong[]): SubsonicSong[] {
  return uniqueBySongId([...base, ...incoming]);
}

function deriveTopArtistsFromFrequentAlbums(albums: SubsonicAlbum[]): TopArtist[] {
  const map = new Map<string, TopArtist>();
  for (const a of albums) {
    const plays = a.playCount ?? 0;
    if (!a.artistId || !a.artist || plays <= 0) continue;
    const prev = map.get(a.artistId);
    if (prev) {
      prev.totalPlays += plays;
      continue;
    }
    map.set(a.artistId, { id: a.artistId, name: a.artist, totalPlays: plays });
  }
  return [...map.values()].sort((a, b) => b.totalPlays - a.totalPlays);
}

async function fetchFrequentAlbumsPool(): Promise<SubsonicAlbum[]> {
  const out: SubsonicAlbum[] = [];
  let offset = 0;
  while (out.length < MOST_PLAYED_MAX_ALBUMS) {
    const page = await getAlbumList('frequent', MOST_PLAYED_PAGE_SIZE, offset);
    if (!page.length) break;
    out.push(...page);
    if (page.length < MOST_PLAYED_PAGE_SIZE) break;
    offset += MOST_PLAYED_PAGE_SIZE;
  }
  return out;
}

async function pickSongsForArtist(
  artist: TopArtist,
  need: number,
  mixRatings: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  const primary = uniqueBySongId(await filterSongsToActiveLibrary(await getTopSongs(artist.name)));
  let pool = primary;
  if (primary.length < need) {
    const extra: SubsonicSong[] = [];
    for (let i = 0; i < 8 && primary.length + extra.length < need * 4; i++) {
      const rnd = await filterSongsToActiveLibrary(await getRandomSongs(120));
      for (const s of rnd) {
        if (s.artistId === artist.id || s.artist === artist.name) {
          extra.push(s);
        }
      }
    }
    pool = uniqueBySongId([...primary, ...extra]);
  }
  const filtered = await filterSongsForLuckyMixRatings(pool, mixRatings);
  return sampleRandom(filtered, Math.min(need, filtered.length));
}

async function pickSongsForAlbum(
  albumId: string,
  need: number,
  mixRatings: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  const full = await getAlbum(albumId).catch(() => null);
  if (!full?.songs?.length) return [];
  const scopedSongs = await filterSongsToActiveLibrary(full.songs);
  const unique = uniqueBySongId(scopedSongs);
  const filtered = await filterSongsForLuckyMixRatings(unique, mixRatings);
  return sampleRandom(filtered, Math.min(need, filtered.length));
}

async function pickGoodRatedSongs(
  existingIds: Set<string>,
  need: number,
  mixRatings: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  const out: SubsonicSong[] = [];
  const push = (s: SubsonicSong) => {
    const r = s.userRating ?? 0;
    if (r < 4) return;
    if (existingIds.has(s.id)) return;
    if (out.some(x => x.id === s.id)) return;
    out.push(s);
  };

  for (let i = 0; i < 14 && out.length < need * 8; i++) {
    const rnd = await filterSongsToActiveLibrary(await getRandomSongs(120));
    rnd.forEach(push);
  }

  const filtered = await filterSongsForLuckyMixRatings(out, mixRatings);
  return sampleRandom(filtered, Math.min(need, filtered.length));
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

  // Drop the old "upcoming" tail immediately so the queue UI does not show stale
  // next tracks while the mix is still building (first playTrack may be delayed).
  usePlayerStore.getState().pruneUpcomingToCurrent();

  lucky.start();
  // Per-run handles. Live outside the try so `finally`/`catch` can read
  // `startedPlayback` (drives the queue-restore decision) and clean up the
  // player-store subscription unconditionally.
  let unsubPlayer: (() => void) | null = null;
  let startedPlayback = false;
  try {
    const queuedIds = new Set<string>();
    let allSeedSongs: SubsonicSong[] = [];

    const bailIfCancelled = () => {
      if (useLuckyMixStore.getState().cancelRequested) throw new LuckyMixCancelled();
    };
    const reachedTarget = () => queuedIds.size >= MIX_TARGET_SIZE;

    const startImmediatePlayback = async (song: SubsonicSong, source: string) => {
      if (startedPlayback || !song?.id) return;
      const allowed = await filterSongsForLuckyMixRatings([song], mixRatingCfg);
      if (!allowed.length) return;
      const play = allowed[0];
      startedPlayback = true;
      queuedIds.add(play.id);
      const track = songToTrack(play);
      usePlayerStore.getState().playTrack(track, [track], true);
      logStep('start_immediate_playback', {
        source,
        song: songDebug([play])[0],
        queuedCount: queuedIds.size,
      });

      // Auto-cancel: once we're playing, watch the player store. If the
      // current track switches to something the user picked themselves (not
      // in our queuedIds set), treat that as "user moved on" and cancel the
      // build so we don't later overwrite their choice with our finalised mix.
      if (!unsubPlayer) {
        unsubPlayer = usePlayerStore.subscribe((state, prev) => {
          const prevId = prev.currentTrack?.id ?? null;
          const nextId = state.currentTrack?.id ?? null;
          if (nextId === prevId) return;
          if (!nextId) return;
          if (queuedIds.has(nextId)) return;
          useLuckyMixStore.getState().cancel();
        });
      }
    };

    const appendSongsToQueue = async (songs: SubsonicSong[], reason: string): Promise<number> => {
      if (useLuckyMixStore.getState().cancelRequested) return 0;
      if (reachedTarget()) return 0;
      if (!songs.length) return 0;
      const unique = uniqueBySongId(songs).filter(s => !queuedIds.has(s.id));
      const deduped = await filterSongsForLuckyMixRatings(unique, mixRatingCfg);
      if (!deduped.length) return 0;

      const candidates = [...deduped];
      if (!startedPlayback && candidates.length > 0) {
        const first = candidates.shift();
        if (first) await startImmediatePlayback(first, reason);
      }

      if (!candidates.length) return 0;
      const remaining = Math.max(0, MIX_TARGET_SIZE - queuedIds.size);
      if (remaining <= 0) return 0;
      const toAdd = sampleRandom(candidates, Math.min(remaining, candidates.length));
      if (!toAdd.length) return 0;
      toAdd.forEach(s => queuedIds.add(s.id));
      usePlayerStore.getState().enqueue(toAdd.map(songToTrack));
      logStep('append_queue_batch', {
        reason,
        added: toAdd.length,
        queuedCount: queuedIds.size,
        songs: songDebug(toAdd),
      });
      return toAdd.length;
    };

    const frequentAlbums = await fetchFrequentAlbumsPool();
    bailIfCancelled();
    const albumsWithPlays = frequentAlbums.filter(a => (a.playCount ?? 0) > 0);
    logStep('fetch_frequent_albums', {
      fetched: frequentAlbums.length,
      withPlays: albumsWithPlays.length,
    });
    const topArtists = deriveTopArtistsFromFrequentAlbums(albumsWithPlays);
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

    for (let i = 0; i < 10 && pool.length < MIX_TARGET_SIZE; i++) {
      bailIfCancelled();
      const rnd = await filterSongsToActiveLibrary(await getRandomSongs(120));
      pool = uniqueAppend(pool, rnd);
      await appendSongsToQueue(rnd, `pool-fill-${i + 1}`);
      logStep('pool_fill_batch', {
        batch: i + 1,
        fetched: rnd.length,
        poolCount: pool.length,
      });
      if (reachedTarget()) break;
    }

    bailIfCancelled();
    const poolFiltered = await filterSongsForLuckyMixRatings(pool, mixRatingCfg);
    const finalSongs = sampleRandom(poolFiltered, MIX_TARGET_SIZE).filter(s => !queuedIds.has(s.id));
    await appendSongsToQueue(finalSongs, 'finalize-randomized');
    logStep('final_queue_state', {
      poolCount: pool.length,
      queuedCount: queuedIds.size,
      queuedTarget: MIX_TARGET_SIZE,
    });
    if (queuedIds.size === 0) {
      throw new Error('empty-mix');
    }
    showToast(i18n.t('luckyMix.done', { count: queuedIds.size }), 3500, 'success');
    logStep('done', { queueCount: queuedIds.size });
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
  } finally {
    if (unsubPlayer) { try { unsubPlayer(); } catch { /* noop */ } }
    useLuckyMixStore.getState().stop();
  }
}
