import { libraryUpsertSongsFromApi } from '@/lib/api/library';
import { buildOriginalStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '@/store/authStore';
import { showToast } from '@/lib/dom/toast';
import {
  cancelledDownloads,
  getOfflineDownloadCancellationVersion,
  markOfflineDownloadCancelled,
  subscribeOfflineDownloadCancellation,
  useOfflineJobStore,
  waitForOfflineRustCancellation,
} from '@/features/offline/store/offlineJobStore';
import {
  localPlaybackEntryHasPinSource,
  useLocalPlaybackStore,
  type PinSource,
} from '@/store/localPlaybackStore';
import { getMediaDir } from '@/lib/media/mediaDir';
import { checkDirAccessible, clearOfflineCancel, deleteMediaFile } from '@/lib/api/syncfs';
import { findLocalPlaybackEntry } from '@/store/localPlaybackResolve';
import {
  isOfflinePinComplete,
  localEntrySatisfiesOriginalRequirement,
  pendingOfflinePinSongs,
} from '@/features/offline/utils/offlineLibraryHelpers';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { isSmartPlaylistName } from '@/lib/format/playlistDetailHelpers';
import {
  enqueueOfflinePin,
  getOfflinePinCancellationEpoch,
  registerOfflinePinExecutor,
  removeOfflinePinTask,
  type OfflinePinResult,
  type OfflinePinTask,
} from '@/features/offline/utils/offlinePinQueue';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import i18n from '@/lib/i18n';
import {
  beginOfflineServerOperation,
  beginOfflineTrackTransfer,
  getOfflineSourceGeneration,
  getOfflineTrackDeletionEpoch,
  invalidateOfflineSource,
  resolveOfflineServerOperationKey,
  runOfflineTrackDeletionBatch,
  runOfflineTrackCleanup,
  waitForOfflineTrackDeletion,
} from '@/features/offline/utils/offlineOperationCoordinator';

/** @deprecated Metadata lives in the library index; kept for type-compat during transition. */
export interface OfflineTrackMeta {
  id: string;
  serverId: string;
  localPath: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId?: string;
  suffix: string;
  duration: number;
  bitRate?: number;
  coverArt?: string;
  year?: number;
  genre?: string;
  replayGainTrackDb?: number;
  replayGainAlbumDb?: number;
  replayGainPeak?: number;
  cachedAt: string;
}

/** @deprecated Grouping uses `pinSource` on local playback entries. */
export interface OfflineAlbumMeta {
  id: string;
  serverId: string;
  name: string;
  artist: string;
  coverArt?: string;
  year?: number;
  trackIds: string[];
  type?: 'album' | 'playlist' | 'artist' | 'track';
}

export type { DownloadJob } from '@/features/offline/store/offlineJobStore';

function serverIndexKeyForOffline(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  const indexKey = server
    ? serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId
    : resolveIndexKey(serverId) || serverId;
  return resolveOfflineServerOperationKey(indexKey);
}

function offlineServerAliases(...serverRefs: string[]): string[] {
  const aliases = new Set<string>();
  const servers = useAuthStore.getState().servers;
  for (const serverRef of serverRefs) {
    if (!serverRef) continue;
    aliases.add(serverRef);
    aliases.add(serverIndexKeyForOffline(serverRef));
    for (const server of servers) {
      const indexKey = serverIndexKeyForProfile(server) || resolveIndexKey(server.id) || server.id;
      if (server.id === serverRef || indexKey === serverRef) {
        aliases.add(server.id);
        aliases.add(indexKey);
      }
    }
  }
  return [...aliases];
}

/** Library SQLite scope (host index key) — not the auth profile UUID. */
function librarySqlScopeForOffline(serverId: string): string {
  return resolveOfflineServerOperationKey(librarySqlServerId(serverId));
}

function activeOfflineServerId(
  albumId: string,
  serverRef: string,
  pinKind?: PinSource['kind'],
): string | null {
  const { jobs, pinQueue } = useOfflineJobStore.getState();
  const candidates = [
    ...pinQueue.filter(entry => (
      entry.albumId === albumId && (!pinKind || entry.pinKind === pinKind)
    )).map(entry => entry.serverId),
    ...jobs.filter(job => (
      job.albumId === albumId && (!pinKind || job.pinKind === pinKind)
    )).map(job => job.serverId),
  ];
  return candidates.find(candidate => (
    candidate === serverRef
      || (candidate
        ? serverIndexKeyForOffline(candidate) === resolveOfflineServerOperationKey(serverRef)
        : false)
  )) ?? null;
}

const OFFLINE_TRACK_CONCURRENCY = 2;
const offlineDeletionBarriers = new Map<string, Promise<void>>();
const activeOfflineAlbumGenerations = new Map<string, string>();
const activeArtistPreparations = new Map<
  string,
  { epoch: number; promise: Promise<void> }
>();
const offlineTrackWaiters: Array<() => void> = [];
let activeOfflineTracks = 0;
let offlineDownloadSequence = 0;

function nextOfflineDownloadId(serverId: string, albumId: string): string {
  offlineDownloadSequence += 1;
  return `${serverId}-${albumId}-${Date.now()}-${offlineDownloadSequence}`;
}

async function acquireOfflineTrackPermit(): Promise<() => void> {
  if (activeOfflineTracks < OFFLINE_TRACK_CONCURRENCY) {
    activeOfflineTracks += 1;
  } else {
    await new Promise<void>(resolve => offlineTrackWaiters.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = offlineTrackWaiters.shift();
    if (next) next();
    else activeOfflineTracks -= 1;
  };
}

function offlineAlbumOperationKey(
  albumId: string,
  serverId: string,
  pinKind: PinSource['kind'],
): string {
  const resolvedServerKey = resolveOfflineServerOperationKey(serverId);
  const profile = useAuthStore.getState().servers.find(server => (
    server.id === serverId || serverIndexKeyForOffline(server.id) === resolvedServerKey
  ));
  return `${profile?.id ?? resolvedServerKey}:${pinKind}:${albumId}`;
}

async function waitForOfflineDeletion(
  albumId: string,
  serverId: string,
  pinKind: PinSource['kind'],
): Promise<void> {
  await offlineDeletionBarriers.get(offlineAlbumOperationKey(albumId, serverId, pinKind));
}

/** Runs one queued offline pin (all tracks for a single album / playlist). */
async function runOfflinePinDownload(
  task: OfflinePinTask,
  markStarted: () => void,
  cancellationVersion: number,
): Promise<OfflinePinResult> {
  const serverLease = await beginOfflineServerOperation(
    serverIndexKeyForOffline(task.serverId),
  );
  try {
    return await runOfflinePinDownloadWithServerLease(
      task,
      markStarted,
      cancellationVersion,
      serverLease,
    );
  } finally {
    serverLease();
  }
}

async function runOfflinePinDownloadWithServerLease(
  task: OfflinePinTask,
  markStarted: () => void,
  cancellationVersion: number,
  serverLease: Awaited<ReturnType<typeof beginOfflineServerOperation>>,
): Promise<OfflinePinResult> {
  const {
    albumId,
    albumName,
    albumArtist,
    coverArt,
    year,
    songs,
    serverId,
    type = 'album',
  } = task;
  const cancelKey = `${serverId}:${albumId}`;
  const isCancelled = () => (
    getOfflineDownloadCancellationVersion(cancelKey) > cancellationVersion
  );
  await waitForOfflineDeletion(albumId, serverId, type);
  if (isCancelled()) return 'cancelled';
  cancelledDownloads.delete(cancelKey);

  const trackIds = songs.map(s => s.id);
  const jobStore = useOfflineJobStore;
  const downloadId = nextOfflineDownloadId(serverId, albumId);
  const serverIndexKey = serverIndexKeyForOffline(serverId);
  const libraryServerId = librarySqlScopeForOffline(serverId);
  const pinSource: PinSource = { kind: type, sourceId: albumId, displayName: albumName };
  const mediaDir = getMediaDir();
  const cleanupUnclaimedNativeResult = async (trackId: string, localPath: string) => {
    const cleanupServerIndexKey = serverIndexKeyForOffline(serverId);
    await runOfflineTrackCleanup(
      cleanupServerIndexKey,
      trackId,
      async () => {
        const latest = findLocalPlaybackEntry(trackId, serverId);
        if (latest?.localPath === localPath) return;
        await deleteMediaFile({ localPath, mediaDir }).catch(() => {});
      },
      serverLease,
    );
  };

  if (mediaDir) {
    const ok = await checkDirAccessible({ path: mediaDir }).catch(() => false);
    if (!ok) {
      showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
      return 'completed';
    }
  }

  useOfflineStore.setState(state => {
    const albums = { ...state.albums };
    for (const alias of offlineServerAliases(serverId, serverIndexKey)) {
      delete albums[`${alias}:${albumId}`];
    }
    albums[`${serverIndexKey}:${albumId}`] = {
      id: albumId,
      serverId: serverIndexKey,
      name: albumName,
      artist: albumArtist,
      coverArt,
      year,
      trackIds,
      type,
    };
    return { albums };
  });
  const albumOperationKey = offlineAlbumOperationKey(albumId, serverId, type);
  activeOfflineAlbumGenerations.set(albumOperationKey, downloadId);
  const clearActiveAlbumGeneration = () => {
    if (activeOfflineAlbumGenerations.get(albumOperationKey) === downloadId) {
      activeOfflineAlbumGenerations.delete(albumOperationKey);
      return true;
    }
    return false;
  };

  const finishCancelledDownload = async () => {
    jobStore.setState(state => ({
      jobs: state.jobs.filter(j => j.downloadId !== downloadId),
    }));
    if (clearActiveAlbumGeneration()) {
      const currentServerIndexKey = serverIndexKeyForOffline(serverId);
      const completedEntryAliases = new Set(offlineServerAliases(
        serverId,
        serverIndexKey,
        currentServerIndexKey,
      ));
      const hasCompletedEntries = Object.values(useLocalPlaybackStore.getState().entries).some(
        entry => completedEntryAliases.has(entry.serverIndexKey)
          && entry.tier === 'library'
          && localPlaybackEntryHasPinSource(entry, pinSource),
      );
      if (!hasCompletedEntries) {
        useOfflineStore.setState(state => {
          const albums = { ...state.albums };
          for (const alias of completedEntryAliases) delete albums[`${alias}:${albumId}`];
          return { albums };
        });
      }
    }
    await waitForOfflineRustCancellation(downloadId);
    await clearOfflineCancel({ downloadId }).catch(() => {});
  };

  await libraryUpsertSongsFromApi(libraryServerId, songs).catch(() => {});
  if (isCancelled()) {
    await finishCancelledDownload();
    return 'cancelled';
  }
  await Promise.all(songs.map(song => waitForOfflineTrackDeletion(
    serverIndexKeyForOffline(serverId),
    song.id,
  )));
  if (isCancelled()) {
    await finishCancelledDownload();
    return 'cancelled';
  }

  const lp = useLocalPlaybackStore.getState();
  const pendingSongs = pendingOfflinePinSongs(songs, serverId);
  if (pendingSongs.length === 0) {
    for (const song of songs) {
      const finishTrackTransfer = await beginOfflineTrackTransfer(
        serverIndexKeyForOffline(serverId),
        song.id,
        serverLease,
      );
      try {
        if (isCancelled()) {
          await finishCancelledDownload();
          return 'cancelled';
        }
        const trackServerIndexKey = serverIndexKeyForOffline(serverId);
        const prev = findLocalPlaybackEntry(song.id, serverId);
        if (!prev || !localEntrySatisfiesOriginalRequirement(prev, serverId)) {
          pendingSongs.push(song);
          continue;
        }
        lp.upsertEntry({
          ...prev,
          serverIndexKey: trackServerIndexKey,
          tier: 'library',
          pinSource,
        });
      } finally {
        finishTrackTransfer();
      }
    }
    if (pendingSongs.length === 0) {
      jobStore.setState(state => ({
        jobs: state.jobs.filter(j => j.downloadId !== downloadId),
      }));
      clearActiveAlbumGeneration();
      return 'completed';
    }
  }

  jobStore.setState(state => ({
    jobs: [
      ...state.jobs.filter(j => j.albumId !== albumId || (j.serverId && j.serverId !== serverId)),
      ...pendingSongs.map((s, i) => ({
        trackId: s.id,
        albumId,
        albumName,
        trackTitle: s.title,
        trackIndex: i,
        totalTracks: pendingSongs.length,
        status: 'queued' as const,
        downloadId,
        serverId,
        pinKind: type,
      })),
    ],
  }));

  let failedTracks = 0;
  let nextSongIndex = 0;
  let cancelled = false;

  const downloadNext = async () => {
    while (!cancelled && !isCancelled()) {
      const song = pendingSongs[nextSongIndex++];
      if (!song) return;

      const releaseTrackPermit = await acquireOfflineTrackPermit();
      if (cancelled || isCancelled()) {
        releaseTrackPermit();
        cancelled = true;
        return;
      }

      let finishTrackTransfer: (() => void) | null = null;
      let finishTransferOnReturn = true;
      try {
        await waitForOfflineTrackDeletion(serverIndexKeyForOffline(serverId), song.id);
        if (cancelled || isCancelled()) {
          cancelled = true;
          return;
        }
        finishTrackTransfer = await beginOfflineTrackTransfer(
          serverIndexKeyForOffline(serverId),
          song.id,
          serverLease,
        );
        if (cancelled || isCancelled()) {
          cancelled = true;
          return;
        }
        const trackServerIndexKey = serverIndexKeyForOffline(serverId);
        const deletionEpoch = getOfflineTrackDeletionEpoch(trackServerIndexKey, song.id);
        markStarted();
        jobStore.setState(state => ({
          jobs: state.jobs.map(j =>
            j.albumId === albumId
              && (!j.serverId || j.serverId === serverId)
              && j.trackId === song.id
              ? { ...j, status: 'downloading' }
              : j,
          ),
        }));

        const suffix = song.suffix || 'mp3';
        let localPath: string | null = null;
        let error: string | null = null;
        const existing = findLocalPlaybackEntry(song.id, serverId);
        if (
          existing?.tier === 'library'
          && localEntrySatisfiesOriginalRequirement(existing, serverId)
        ) {
          const latestExisting = findLocalPlaybackEntry(song.id, serverId);
          if (
            getOfflineTrackDeletionEpoch(trackServerIndexKey, song.id) !== deletionEpoch
            || latestExisting?.tier !== 'library'
            || !localEntrySatisfiesOriginalRequirement(latestExisting, serverId)
          ) {
            pendingSongs.push(song);
            continue;
          }
          useLocalPlaybackStore.getState().upsertEntry({
            ...latestExisting,
            serverIndexKey: trackServerIndexKey,
            pinSource,
            suffix: latestExisting.suffix || suffix,
          });
          localPath = latestExisting.localPath;
        } else {
          const nativeResult = invoke<{
            path: string;
            size: number;
            layoutFingerprint: string;
            originalBytesVerified: boolean;
          }>(
            'download_track_local',
            {
              tier: 'library',
              trackId: song.id,
              serverIndexKey: trackServerIndexKey,
              libraryServerId,
              url: buildOriginalStreamUrlForServer(serverId, song.id),
              suffix,
              mediaDir,
              downloadId,
            },
          );
          let signalCancellation!: () => void;
          const cancellation = new Promise<void>(resolve => {
            signalCancellation = resolve;
          });
          const unsubscribeCancellation = subscribeOfflineDownloadCancellation(
            cancelKey,
            signalCancellation,
          );
          const finishTransferBeforeCleanup = () => {
            if (!finishTransferOnReturn) return;
            finishTransferOnReturn = false;
            finishTrackTransfer?.();
          };
          try {
            const outcome = await Promise.race([
              nativeResult.then(res => ({ kind: 'result' as const, res })),
              cancellation.then(() => ({ kind: 'cancelled' as const })),
            ]);
            if (outcome.kind === 'cancelled') {
              try {
                const res = await nativeResult;
                finishTransferBeforeCleanup();
                await cleanupUnclaimedNativeResult(song.id, res.path);
              } catch {
                finishTransferBeforeCleanup();
              }
              error = 'CANCELLED';
            } else if (isCancelled()) {
              const { res } = outcome;
              finishTransferBeforeCleanup();
              await cleanupUnclaimedNativeResult(song.id, res.path);
              error = 'CANCELLED';
            } else {
              const { res } = outcome;
              await waitForOfflineTrackDeletion(trackServerIndexKey, song.id);
              if (isCancelled()) {
                finishTransferBeforeCleanup();
                await cleanupUnclaimedNativeResult(song.id, res.path);
                error = 'CANCELLED';
              } else if (
                getOfflineTrackDeletionEpoch(trackServerIndexKey, song.id) !== deletionEpoch
              ) {
                pendingSongs.push(song);
                continue;
              } else {
                useLocalPlaybackStore.getState().upsertEntry({
                  serverIndexKey: trackServerIndexKey,
                  trackId: song.id,
                  localPath: res.path,
                  sizeBytes: res.size,
                  layoutFingerprint: res.layoutFingerprint,
                  tier: 'library',
                  pinSource,
                  suffix,
                  originalBytesVerified: res.originalBytesVerified,
                });
                localPath = res.path;
              }
            }
          } catch (err) {
            error = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'error');
            if (error === 'VOLUME_NOT_FOUND' && !isCancelled()) {
              markOfflineDownloadCancelled(cancelKey);
              showToast('Speichermedium nicht gefunden. Bitte Verzeichnis in den Einstellungen prüfen.', 6000, 'error');
            } else if (error !== 'CANCELLED') {
              console.error('[offline] track download failed', {
                serverId,
                albumId,
                trackId: song.id,
                error,
              });
            }
          } finally {
            unsubscribeCancellation();
          }
        }

        if (error === 'CANCELLED') {
          cancelled = true;
          return;
        }

        jobStore.setState(state => ({
          jobs: state.jobs.map(j =>
            j.albumId === albumId
              && (!j.serverId || j.serverId === serverId)
              && j.trackId === song.id
              ? { ...j, status: localPath ? 'done' : 'error' }
              : j,
          ),
        }));
        if (!localPath) failedTracks += 1;
      } finally {
        if (finishTransferOnReturn) finishTrackTransfer?.();
        releaseTrackPermit();
      }
    }
    if (isCancelled()) cancelled = true;
  };

  await Promise.all(
    Array.from(
      { length: Math.min(OFFLINE_TRACK_CONCURRENCY, pendingSongs.length) },
      () => downloadNext(),
    ),
  );

  if (cancelled || isCancelled()) {
    await finishCancelledDownload();
    return 'cancelled';
  }

  await clearOfflineCancel({ downloadId }).catch(() => {});
  if (failedTracks > 0) {
    showToast(i18n.t('albums.offlineFailed', { name: albumName }), 6000, 'error');
  }
  setTimeout(() => {
    jobStore.setState(state => ({
      jobs: state.jobs.filter(j => (
        j.downloadId !== downloadId || (j.status !== 'done' && j.status !== 'error')
      )),
    }));
  }, 2500);
  clearActiveAlbumGeneration();
  return 'completed';
}

interface OfflineState {
  /** Legacy shim — new pins use `localPlaybackStore` only. */
  albums: Record<string, OfflineAlbumMeta>;
  isDownloaded: (trackId: string, serverId: string) => boolean;
  isAlbumDownloaded: (albumId: string, serverId: string) => boolean;
  isAlbumDownloading: (albumId: string, serverId?: string) => boolean;
  getLocalUrl: (trackId: string, serverId: string) => string | null;
  downloadAlbum: (
    albumId: string,
    albumName: string,
    albumArtist: string,
    coverArt: string | undefined,
    year: number | undefined,
    songs: SubsonicSong[],
    serverId: string,
    type?: 'album' | 'playlist' | 'artist' | 'track',
  ) => Promise<void>;
  downloadPlaylist: (playlistId: string, playlistName: string, coverArt: string | undefined, songs: SubsonicSong[], serverId: string) => Promise<void>;
  downloadArtist: (artistId: string, artistName: string, serverId: string) => Promise<void>;
  deleteAlbum: (
    albumId: string,
    serverId: string,
    pinSource?: PinSource,
  ) => Promise<void>;
  clearAll: (serverId: string) => Promise<void>;
  getAlbumProgress: (albumId: string, serverId?: string) => { done: number; total: number } | null;
}

export const useOfflineStore = create<OfflineState>()(
  persist(
    (set, get) => ({
      albums: {},

      isDownloaded: (trackId, serverId) =>
        useLocalPlaybackStore.getState().isPinned(trackId, serverIndexKeyForOffline(serverId)),

      isAlbumDownloaded: (albumId, serverId) => {
        const indexKey = serverIndexKeyForOffline(serverId);
        const group = useLocalPlaybackStore.getState().listPinnedGroups(indexKey)
          .find(g => g.pinSource.sourceId === albumId);
        if (!group || group.trackIds.length === 0) return false;
        return group.trackIds.every(tid =>
          useLocalPlaybackStore.getState().isPinned(tid, indexKey),
        );
      },

      isAlbumDownloading: (albumId, serverId) => {
        const jobState = useOfflineJobStore.getState();
        return jobState.pinQueue.some(p => p.albumId === albumId && (!serverId || !p.serverId || p.serverId === serverId))
          || jobState.jobs.some(
            j => j.albumId === albumId
              && (!serverId || !j.serverId || j.serverId === serverId)
              && (j.status === 'queued' || j.status === 'downloading'),
          );
      },

      getLocalUrl: (trackId, serverId) =>
        useLocalPlaybackStore.getState().getLocalUrl(trackId, serverIndexKeyForOffline(serverId), 'library'),

      clearAll: async (serverId) => {
        const indexKey = serverIndexKeyForOffline(serverId);
        const serverAliases = offlineServerAliases(serverId, indexKey);
        const groups = useLocalPlaybackStore.getState().listPinnedGroups()
          .filter(group => serverAliases.includes(group.serverIndexKey));
        for (const group of groups) {
          const targets = Object.values(useLocalPlaybackStore.getState().entries)
            .filter(entry => entry.serverIndexKey === group.serverIndexKey
              && entry.tier === 'library'
              && localPlaybackEntryHasPinSource(entry, group.pinSource))
            .map(entry => ({ serverIndexKey: indexKey, trackId: entry.trackId }));
          await runOfflineTrackDeletionBatch(
            targets,
            () => useLocalPlaybackStore.getState().removeEntriesByPinSource(
              group.serverIndexKey,
              group.pinSource,
              getMediaDir(),
            ),
          );
        }
        set(state => {
          const albums = { ...state.albums };
          for (const key of Object.keys(albums)) {
            if (serverAliases.some(alias => key.startsWith(`${alias}:`))) {
              delete albums[key];
            }
          }
          return { albums };
        });
      },

      getAlbumProgress: (albumId, serverId) => {
        const albumJobs = useOfflineJobStore.getState().jobs.filter(
          j => j.albumId === albumId && (!serverId || !j.serverId || j.serverId === serverId),
        );
        if (albumJobs.length === 0) return null;
        const done = albumJobs.filter(j => j.status === 'done').length;
        return { done, total: albumJobs.length };
      },

      downloadAlbum: async (albumId, albumName, albumArtist, coverArt, year, songs, serverId, type = 'album') => {
        enqueueOfflinePin({
          albumId,
          albumName,
          albumArtist,
          coverArt,
          year,
          songs,
          serverId,
          type,
        });
      },

      downloadPlaylist: async (playlistId, playlistName, coverArt, songs, serverId) => {
        if (isSmartPlaylistName(playlistName)) return;
        const seen = new Set<string>();
        const unique = songs.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
        await get().downloadAlbum(playlistId, playlistName, '', coverArt, undefined, unique, serverId, 'playlist');
      },

      downloadArtist: async (artistId, artistName, serverId) => {
        const progressKey = ownedEntityKey({ id: artistId, serverId });
        const preparationCancellationEpoch = getOfflinePinCancellationEpoch();
        const activePreparation = activeArtistPreparations.get(progressKey);
        if (activePreparation?.epoch === preparationCancellationEpoch) {
          await activePreparation.promise;
          return;
        }
        const preparation = (async () => {
          const jobStore = useOfflineJobStore;
          const albums = await getArtistForServer(serverId, artistId)
            .then(res => res.albums)
            .catch(() => []);
          if (getOfflinePinCancellationEpoch() !== preparationCancellationEpoch) return;
          if (albums.length === 0) return;

          const offline = get();
          const artistSourceIndexKey = serverIndexKeyForOffline(serverId);
          let doneCount = 0;
          const toEnqueue: Array<{ task: OfflinePinTask; sourceGeneration: number }> = [];
          for (const album of albums) {
            if (getOfflinePinCancellationEpoch() !== preparationCancellationEpoch) return;
            if (isOfflinePinComplete(
              album.id,
              serverId,
              undefined,
              { kind: 'artist', sourceId: album.id },
            )) {
              doneCount += 1;
              continue;
            }
            if (offline.isAlbumDownloading(album.id, serverId)) continue;
            const sourceGeneration = getOfflineSourceGeneration(
              artistSourceIndexKey,
              'artist',
              album.id,
            );
            try {
              const { songs } = await getAlbumForServer(serverId, album.id);
              if (getOfflinePinCancellationEpoch() !== preparationCancellationEpoch) return;
              if (getOfflineSourceGeneration(
                artistSourceIndexKey,
                'artist',
                album.id,
              ) !== sourceGeneration) continue;
              toEnqueue.push({
                sourceGeneration,
                task: {
                  albumId: album.id,
                  albumName: album.name,
                  albumArtist: album.artist || artistName,
                  coverArt: album.coverArt,
                  year: album.year,
                  songs,
                  serverId,
                  type: 'artist',
                  artistProgressGroupId: progressKey,
                },
              });
            } catch {
              if (getOfflinePinCancellationEpoch() !== preparationCancellationEpoch) return;
              /* skip failed album */
            }
          }

          let acceptedTasks = 0;
          for (const { task, sourceGeneration } of toEnqueue) {
            if (getOfflinePinCancellationEpoch() !== preparationCancellationEpoch) return;
            if (getOfflineSourceGeneration(
              artistSourceIndexKey,
              'artist',
              task.albumId,
            ) !== sourceGeneration) continue;
            if (isOfflinePinComplete(
              task.albumId,
              serverId,
              task.songs.map(song => song.id),
              { kind: 'artist', sourceId: task.albumId },
            )) {
              doneCount += 1;
              continue;
            }
            if (get().isAlbumDownloading(task.albumId, serverId)) continue;
            if (enqueueOfflinePin(task)) acceptedTasks += 1;
          }
          if (acceptedTasks === 0) return;

          const trackedTotal = doneCount + acceptedTasks;
          jobStore.getState().setBulkProgress(progressKey, {
            done: doneCount,
            total: trackedTotal,
          });
        })();
        const preparationRecord = { epoch: preparationCancellationEpoch, promise: preparation };
        activeArtistPreparations.set(progressKey, preparationRecord);
        try {
          await preparation;
        } finally {
          if (activeArtistPreparations.get(progressKey) === preparationRecord) {
            activeArtistPreparations.delete(progressKey);
          }
        }
      },

      deleteAlbum: async (albumId, serverId, requestedPinSource) => {
        const jobServerId = activeOfflineServerId(
          albumId,
          serverId,
          requestedPinSource?.kind,
        ) ?? serverId;
        const serverAliases = offlineServerAliases(jobServerId, serverId);
        const album = serverAliases
          .map(alias => get().albums[`${alias}:${albumId}`])
          .find(Boolean);
        const pinnedGroup = useLocalPlaybackStore.getState().listPinnedGroups()
          .find(group => serverAliases.includes(group.serverIndexKey)
            && group.pinSource.sourceId === albumId
            && (!requestedPinSource
              || (group.pinSource.kind === requestedPinSource.kind
                && group.pinSource.sourceId === requestedPinSource.sourceId)));
        const pinSource: PinSource = requestedPinSource ?? (album
          ? { kind: album.type ?? 'album', sourceId: albumId, displayName: album.name }
          : pinnedGroup?.pinSource ?? { kind: 'album', sourceId: albumId });
        const operationKey = offlineAlbumOperationKey(
          albumId,
          jobServerId,
          pinSource.kind,
        );
        const activeDeletion = offlineDeletionBarriers.get(operationKey);
        if (activeDeletion) {
          await activeDeletion;
          return;
        }
        useOfflineJobStore.getState().cancelDownload(
          albumId,
          jobServerId,
          pinSource.kind,
        );
        removeOfflinePinTask(albumId, jobServerId, pinSource.kind);
        for (const alias of serverAliases) {
          invalidateOfflineSource(alias, pinSource.kind, pinSource.sourceId);
        }
        const deletionTargets = Object.values(useLocalPlaybackStore.getState().entries).filter(
          entry => serverAliases.includes(entry.serverIndexKey)
            && entry.tier === 'library'
            && localPlaybackEntryHasPinSource(entry, pinSource),
        );
        let startDeletion!: () => void;
        const startGate = new Promise<void>(resolve => {
          startDeletion = resolve;
        });
        const deletion = (async () => {
          await startGate;
          await runOfflineTrackDeletionBatch(
            deletionTargets.map(entry => ({
              serverIndexKey: serverIndexKeyForOffline(entry.serverIndexKey),
              trackId: entry.trackId,
            })),
            async () => {
              for (const alias of serverAliases) {
                await useLocalPlaybackStore.getState().removeEntriesByPinSource(
                  alias,
                  pinSource,
                  getMediaDir(),
                );
              }
              set(state => {
                const albums = { ...state.albums };
                for (const alias of serverAliases) delete albums[`${alias}:${albumId}`];
                return { albums };
              });
              for (const alias of serverAliases) {
                invalidateOfflineSource(alias, pinSource.kind, pinSource.sourceId);
              }
            },
          );
        })();
        offlineDeletionBarriers.set(operationKey, deletion);
        startDeletion();
        try {
          await deletion;
        } finally {
          if (offlineDeletionBarriers.get(operationKey) === deletion) {
            offlineDeletionBarriers.delete(operationKey);
          }
        }
      },
    }),
    {
      name: 'psysonic-offline',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ albums: state.albums }),
    },
  ),
);

registerOfflinePinExecutor(runOfflinePinDownload);
