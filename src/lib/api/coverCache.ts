import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { useThemeStore } from '@/store/themeStore';
import { coverIndexKeyFromRef, coverStorageKeyFromRef } from '@/cover/storageKeys';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { getPlaybackServerId } from '@/features/playback/utils/playback/playbackServer';
import { restBaseFromUrl } from '@/lib/api/subsonicClient';
import type { CoverArtRef, CoverArtTier } from '@/cover/types';

/** Library SQLite `track.server_id` uses host index keys, not auth profile UUIDs. */
export function librarySqlServerId(profileOrIndexServerId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === profileOrIndexServerId);
  if (server) return serverIndexKeyForProfile(server);
  return profileOrIndexServerId;
}

/** Host root for Rust `build_cover_art_url` (`{host}/rest/getCoverArt.view`). */
export function coverCacheRestHost(serverUrl: string): string {
  return restBaseFromUrl(serverUrl).replace(/\/rest$/i, '');
}

export type CoverCacheEnsureResult = {
  hit: boolean;
  path: string;
  tier: CoverArtTier;
};

export type CoverCacheStats = {
  bytes: number;
  count: number;
  pressure: 'ok' | 'pressure' | 'full';
  autoDownloadEnabled: boolean;
  entryCount: number;
};

export type CoverPipelineQueueStatsDto = {
  httpMax: number;
  httpActive: number;
  cpuUiMax: number;
  cpuUiActive: number;
  cpuBackfillMax: number;
  cpuBackfillActive: number;
  libraryBackfillHttpMax: number;
  libraryBackfillHttpActive: number;
  libraryBackfillPassRunning: boolean;
  uiEnsuredTotal: number;
};

let coverAutoDownloadEnabled = true;

export function setCoverCacheAutoDownloadEnabled(enabled: boolean): void {
  coverAutoDownloadEnabled = enabled;
}

export type CoverEnsureOpts = {
  /** External-artwork surface intent — `'fanart'` for the 16:9 artist background (§28). */
  surfaceKind?: string;
  /** §19 name→MusicBrainz context: the artist display name + the album in context. */
  artistName?: string;
  albumTitle?: string;
};

/**
 * External-artwork ensure fields (§28). `externalArtworkEnabled` is gated by the
 * master toggle AND restricted to the external artist surfaces (`fanart` /
 * `banner`), so plain album/artist cover ensures are never affected.
 */
function externalEnsureFields(ref: CoverArtRef, opts?: CoverEnsureOpts) {
  const surfaceKind = opts?.surfaceKind;
  const isExternalSurface = surfaceKind === 'fanart' || surfaceKind === 'banner';
  const theme = useThemeStore.getState();
  const externalArtworkEnabled =
    isExternalSurface && ref.cacheKind === 'artist' && theme.externalArtworkEnabled;
  return {
    externalArtworkEnabled,
    surfaceKind,
    artistName: opts?.artistName,
    albumTitle: opts?.albumTitle,
    // BYOK personal fanart.tv key (§22), only when the external branch will run.
    externalArtworkByok: externalArtworkEnabled ? theme.externalArtworkByok : undefined,
  };
}

function ensureArgsFromRef(ref: CoverArtRef, tier: CoverArtTier, opts?: CoverEnsureOpts) {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const scope = ref.serverScope;
  if (scope.kind === 'server') {
    // scope.url is the index-stable primary; the Rust cover fetcher needs
    // the runtime connect URL (LAN or public, whichever currently answers).
    return {
      serverIndexKey: coverIndexKeyFromRef(ref),
      cacheKind: ref.cacheKind,
      cacheEntityId: ref.cacheEntityId,
      coverArtId: ref.fetchCoverArtId,
      tier,
      restBaseUrl: coverCacheRestHost(
        connectBaseUrlForServer({ id: scope.serverId, url: scope.url }),
      ),
      username: scope.username,
      password: scope.password,
      ...externalEnsureFields(ref, opts),
    };
  }
  const server =
    scope.kind === 'playback'
      ? (() => {
          const playbackServerId = getPlaybackServerId();
          if (playbackServerId) {
            const playbackServer = useAuthStore
              .getState()
              .servers.find(s => s.id === playbackServerId);
            if (playbackServer) return playbackServer;
          }
          return getActiveServer();
        })()
      : getActiveServer();
  const baseUrl = server ? connectBaseUrlForServer(server) : getBaseUrl();
  return {
    serverIndexKey: coverIndexKeyFromRef(ref),
    cacheKind: ref.cacheKind,
    cacheEntityId: ref.cacheEntityId,
    coverArtId: ref.fetchCoverArtId,
    tier,
    restBaseUrl: baseUrl ? coverCacheRestHost(baseUrl) : '',
    username: server?.username ?? '',
    password: server?.password ?? '',
    ...externalEnsureFields(ref, opts),
  };
}

export type CoverCachePeekItem = {
  serverIndexKey: string;
  cacheKind: 'album' | 'artist';
  cacheEntityId: string;
  tier: CoverArtTier;
  storageKey: string;
};

/** Disk-only — no HTTP. Returns map storageKey → absolute .webp path. */
export async function coverCachePeekBatch(
  refs: CoverArtRef[],
  tier: CoverArtTier,
): Promise<Record<string, string>> {
  if (refs.length === 0) return {};
  const items: CoverCachePeekItem[] = refs.map(ref => ({
    serverIndexKey: coverIndexKeyFromRef(ref),
    cacheKind: ref.cacheKind,
    cacheEntityId: ref.cacheEntityId,
    tier,
    storageKey: coverStorageKeyFromRef(ref, tier),
  }));
  const res = await commands.coverCachePeekBatch(items);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function coverCacheEnsure(
  ref: CoverArtRef,
  tier: CoverArtTier,
  _priority?: string,
  opts?: CoverEnsureOpts,
): Promise<CoverCacheEnsureResult> {
  const res = await commands.coverCacheEnsure(ensureArgsFromRef(ref, tier, opts));
  if (res.status === 'error') throw new Error(res.error);
  // Generated `tier` widens to number; local result keeps the CoverArtTier union.
  return res.data as CoverCacheEnsureResult;
}

export async function coverCacheEnsureBatch(
  refs: CoverArtRef[],
  tier: CoverArtTier,
  _priority?: string,
): Promise<void> {
  if (refs.length === 0) return;
  const items = refs.map(ref => ensureArgsFromRef(ref, tier));
  const res = await commands.coverCacheEnsureBatch(items);
  if (res.status === 'error') throw new Error(res.error);
}

export async function coverCacheStats(): Promise<CoverCacheStats> {
  const res = await commands.coverCacheStats();
  if (res.status === 'error') throw new Error(res.error);
  // Generated `pressure` widens to string; local type keeps the union.
  const stats = res.data as CoverCacheStats;
  setCoverCacheAutoDownloadEnabled(stats.autoDownloadEnabled);
  return stats;
}

/** Clears all servers (legacy). Prefer `coverCacheClearServer`. */
export async function coverCacheClear(): Promise<void> {
  const res = await commands.coverCacheClear();
  if (res.status === 'error') throw new Error(res.error);
}

export async function coverCacheClearServer(serverIndexKey: string): Promise<void> {
  const res = await commands.coverCacheClearServer(serverIndexKey);
  if (res.status === 'error') throw new Error(res.error);
}

/**
 * Opt-out purge: when the External Artwork toggle is turned off, drop every
 * fetched external image + `.miss-*` marker + lookup row across all configured
 * servers (Navidrome covers are left intact). Fire-and-forget; per-server
 * failures are swallowed so one unreachable server can't block the rest.
 */
export async function purgeExternalArtworkAllServers(): Promise<void> {
  const { servers } = useAuthStore.getState();
  await Promise.all(
    servers.map(s =>
      commands.coverCachePurgeExternal(serverIndexKeyForProfile(s)).catch(() => undefined),
    ),
  );
}

export async function coverCacheStatsServer(
  serverIndexKey: string,
): Promise<Pick<CoverCacheStats, 'bytes' | 'entryCount'>> {
  const res = await commands.coverCacheStatsServer(serverIndexKey);
  if (res.status === 'error') throw new Error(res.error);
  return { bytes: res.data.bytes, entryCount: res.data.entryCount };
}

export async function coverGetPipelineQueueStats(): Promise<CoverPipelineQueueStatsDto> {
  const res = await commands.coverCacheGetPipelineQueueStats();
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryCoverBackfillBatch(
  serverIndexKey: string,
  libraryServerId: string,
  cursor?: string | null,
  limit?: number,
): Promise<{ coverIds: string[]; nextCursor: string | null; exhausted: boolean }> {
  const sqlServerId = librarySqlServerId(libraryServerId);
  const diskKey = serverIndexKey || sqlServerId;
  const res = await commands.libraryCoverBackfillBatch(diskKey, sqlServerId, cursor ?? null, limit ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryCoverProgress(
  serverIndexKey: string,
  libraryServerId: string,
): Promise<{ totalDistinct: number; pending: number; done: number }> {
  const sqlServerId = librarySqlServerId(libraryServerId);
  const diskKey = serverIndexKey || sqlServerId;
  const res = await commands.libraryCoverProgress(diskKey, sqlServerId);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export type LibraryCoverBackfillConfigureArgs = {
  enabled: boolean;
  serverIndexKey: string;
  libraryServerId: string;
  restBaseUrl: string;
  username: string;
  password: string;
};

export async function libraryCoverBackfillConfigure(
  args: LibraryCoverBackfillConfigureArgs,
): Promise<void> {
  const res = await commands.libraryCoverBackfillConfigure(
    args.enabled,
    args.serverIndexKey,
    args.libraryServerId,
    args.restBaseUrl,
    args.username,
    args.password,
  );
  if (res.status === 'error') throw new Error(res.error);
}

/**
 * Push the current reachable connect URL to the native backfill worker without
 * rebuilding the session. The worklist is URL-agnostic; each fetch reads this
 * value live, so a LAN→public flip is honoured by the in-flight pass too. A real
 * change clears the stale fetch-failed backoff and kicks a retry pass.
 */
export async function libraryCoverBackfillSetBaseUrl(restBaseUrl: string): Promise<void> {
  const res = await commands.libraryCoverBackfillSetBaseUrl(restBaseUrl);
  if (res.status === 'error') throw new Error(res.error);
}

export type CoverBackfillPulseResult = {
  scheduled: number;
  exhausted: boolean;
  pending: number;
  done: number;
  total: number;
  status: 'idle' | 'active' | 'blocked_sync' | 'blocked_pressure' | 'disabled' | string;
};

/** One backfill step (legacy); prefer `libraryCoverBackfillRunFullPass`. */
export async function libraryCoverBackfillPulse(): Promise<CoverBackfillPulseResult> {
  const res = await commands.libraryCoverBackfillPulse();
  if (res.status === 'error') throw new Error(res.error);
  // Generated `status` widens to string; local type keeps the union.
  return res.data as CoverBackfillPulseResult;
}

/**
 * Start one full-catalog pass on the native runtime (works when the window is inactive).
 * `force` bypasses the idle gate and clears the fetch-failed backoff so previously
 * unfetchable (404) covers are retried — used by the manual "Run full pass now".
 */
export async function libraryCoverBackfillRunFullPass(
  force = false,
): Promise<{ started: boolean }> {
  const res = await commands.libraryCoverBackfillRunFullPass(force);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryCoverBackfillResetCursor(): Promise<void> {
  const res = await commands.libraryCoverBackfillResetCursor();
  if (res.status === 'error') throw new Error(res.error);
}

/** Yield native library backfill while the user navigates (visible covers first). */
export async function libraryCoverBackfillSetUiPriority(hold: boolean): Promise<void> {
  const res = await commands.libraryCoverBackfillSetUiPriority(hold);
  if (res.status === 'error') throw new Error(res.error);
}

/** Perf-probe only: retune cover backfill threads (download + encode). Returns the clamped value applied. */
export async function libraryCoverBackfillSetParallel(threads: number): Promise<number> {
  const res = await commands.libraryCoverBackfillSetParallel(threads);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryCoverClearFetchFailures(serverIndexKey: string): Promise<number> {
  const res = await commands.libraryCoverClearFetchFailures(serverIndexKey);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryCoverCatalogSize(libraryServerId: string): Promise<number> {
  const res = await commands.libraryCoverCatalogSize(librarySqlServerId(libraryServerId));
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export function coverCacheMayBackgroundDownload(): boolean {
  return coverAutoDownloadEnabled;
}
