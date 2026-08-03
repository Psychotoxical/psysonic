import { commands } from '@/generated/bindings';
import { librarySqlServerId } from '@/lib/api/coverCache';

/**
 * Artist ids for credit names the server did not hand us structurally.
 *
 * When a row carries only a joined credit ("A feat. B"), splitting it yields names
 * without ids — see `displayArtistRefs`. The artist rows themselves are in the local
 * index, so the ids can be looked up by name.
 *
 * Requests are collected across callers and flushed on a microtask, so a track list
 * that mounts fifty rows at once produces one round trip rather than fifty. That
 * matters beyond call count: the command takes the library's single shared read
 * connection, which browse and search contend for.
 *
 * Results are cached process-wide, including "no artist row" — a negative result is
 * as worth keeping as a positive one, otherwise unmatched guests re-query forever.
 *
 * The cache is observable: every write, invalidation and scheduled retry bumps a
 * revision that subscribers read. Consumers mount and unmount lazily (virtualized
 * rows) and the index changes underneath them (sync), so "resolve once per mount" is
 * not enough — a row that mounted while a lookup was already running, or while the
 * index still lacked the artist, has to be told when that changes.
 */
const idByKey = new Map<string, string | null>();

/** Names queued for the next flush, per SQL server id. */
let queuedByServer = new Map<string, Set<string>>();
/**
 * In-flight lookup per cache key. A caller that arrives after a batch started awaits
 * *that* batch instead of a fresh empty flush, so it is never told "done" before the
 * value exists.
 */
const inflightByKey = new Map<string, Promise<void>>();
let flushHandle: { promise: Promise<void>; resolve: () => void } | null = null;

/**
 * Invalidation generation. A batch captures it when it starts and discards its answers
 * if the cache was cleared meanwhile — otherwise a lookup issued before a sync could
 * write its pre-sync answer (a stale negative, or an id that has since been renamed
 * or pruned) back over the cleared cache.
 */
let generation = 0;
/** Bumped on every observable change; subscribers re-read the cache when it moves. */
let revision = 0;
const listeners = new Set<() => void>();

/** Backend cap per call (`RESOLVE_ARTIST_IDS_MAX`); chunk deliberately, not by luck. */
const RESOLVE_BATCH_SIZE = 32;

/**
 * Failed lookups are not cached, so they stay retryable — but nothing would re-trigger
 * them while a component sits mounted. One retry is scheduled instead, backing off so a
 * persistently busy index is not polled: the usual failure here *is* backend
 * contention, and a tight retry loop would add to it.
 */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
let retryDelayMs = RETRY_BASE_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Same fold the index stores in `artist.name_fold` (`trim().to_lowercase()`). */
function foldName(name: string): string {
  return name.trim().toLowerCase();
}

function cacheKey(sqlServerId: string, name: string): string {
  return `${sqlServerId}\u0000${foldName(name)}`;
}

function notify(): void {
  revision += 1;
  for (const listener of [...listeners]) listener();
}

/** Subscribe to cache changes (writes, invalidation, scheduled retries). */
export function subscribeArtistIdResolve(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic revision of the cache — the snapshot subscribers compare against. */
export function getArtistIdResolveRevision(): number {
  return revision;
}

/** Cached id, `null` for "known to have no artist row", `undefined` when unresolved. */
export function peekArtistIdByName(
  serverId: string | null | undefined,
  name: string | null | undefined,
): string | null | undefined {
  const server = serverId?.trim();
  const value = name?.trim();
  if (!server || !value) return undefined;
  return idByKey.get(cacheKey(librarySqlServerId(server), value));
}

function scheduleRetryAfterFailure(): void {
  if (retryTimer || listeners.size === 0) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // Nothing is re-queued here: bumping the revision makes mounted consumers notice
    // their names are still unresolved and ask again, which keeps one code path for
    // "who wants what" instead of a second queue that could drift from it.
    notify();
  }, delay);
}

async function runBatch(sqlServerId: string, names: string[], batchGeneration: number): Promise<void> {
  let wrote = false;
  let failed = false;
  let retired = false;
  for (let start = 0; start < names.length; start += RESOLVE_BATCH_SIZE) {
    const chunk = names.slice(start, start + RESOLVE_BATCH_SIZE);
    try {
      const res = await commands.libraryResolveArtistIds(sqlServerId, chunk);
      // Only an `ok` result carries answers. An `err` (busy index, poisoned read
      // lock, sync in progress) says nothing about whether these artists exist, so
      // caching it as "no artist row" would make every guest permanently unlinkable.
      if (res.status === 'ok') {
        // A clear that happened while this call was in flight retires it: the answers
        // describe an index state the cache has already been told to forget.
        if (batchGeneration === generation) {
          chunk.forEach((name, index) => {
            idByKey.set(cacheKey(sqlServerId, name), res.data[index] ?? null);
          });
          wrote = true;
        } else {
          retired = true;
        }
      } else {
        failed = true;
      }
    } catch {
      // Same reasoning as above: leave the names uncached so a later render retries.
      failed = true;
    } finally {
      for (const name of chunk) inflightByKey.delete(cacheKey(sqlServerId, name));
    }
  }
  if (wrote) {
    retryDelayMs = RETRY_BASE_MS;
    notify();
  } else if (failed || retired) {
    // A retired batch leaves its names uncached just like a failure does, and the
    // consumers that awaited it are still mounted holding unresolved credits. The
    // clear itself already notified them, but that happened while this request was
    // in flight, so they re-joined *this* batch and its discarded answer is the last
    // thing they hear. The same backing-off signal covers both cases.
    scheduleRetryAfterFailure();
  }
}

function scheduleFlush(): Promise<void> {
  if (flushHandle) return flushHandle.promise;
  let resolveFlush!: () => void;
  const promise = new Promise<void>(resolve => {
    resolveFlush = resolve;
  });
  flushHandle = { promise, resolve: resolveFlush };
  queueMicrotask(() => {
    const batch = queuedByServer;
    const handle = flushHandle!;
    queuedByServer = new Map();
    flushHandle = null;
    const batchGeneration = generation;
    const running = Promise.all(
      [...batch.entries()].map(([sqlServerId, names]) =>
        runBatch(sqlServerId, [...names], batchGeneration)),
    ).then(() => handle.resolve());
    // Every key of this batch resolves with the batch itself, so a later caller for
    // the same name awaits the real request instead of an immediately-resolving flush.
    for (const [sqlServerId, names] of batch) {
      for (const name of names) inflightByKey.set(cacheKey(sqlServerId, name), running.then(() => {}));
    }
  });
  return promise;
}

/**
 * Resolve names to artist ids, filling the cache. Already-cached names cost nothing;
 * a name someone else is already fetching is awaited on that request. Resolves once
 * the work covering these names has completed — read the values back with
 * {@link peekArtistIdByName}.
 */
export async function resolveArtistIdsByName(
  serverId: string | null | undefined,
  names: ReadonlyArray<string>,
): Promise<void> {
  const server = serverId?.trim();
  if (!server) return;
  const sqlServerId = librarySqlServerId(server);

  const awaited: Promise<void>[] = [];
  let queued = queuedByServer.get(sqlServerId);
  let queuedAny = false;
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;
    const key = cacheKey(sqlServerId, name);
    if (idByKey.has(key)) continue;
    const inflight = inflightByKey.get(key);
    if (inflight) {
      awaited.push(inflight);
      continue;
    }
    if (!queued) {
      queued = new Set();
      queuedByServer.set(sqlServerId, queued);
    }
    // Placeholder so a caller arriving before the microtask runs joins this batch;
    // `scheduleFlush` replaces it with the promise of the request that carries it.
    inflightByKey.set(key, scheduleFlush());
    queued.add(name);
    queuedAny = true;
  }

  if (queuedAny) awaited.push(scheduleFlush());
  await Promise.all(awaited);
}

/** Test seam — the cache is process-wide and would leak between cases. */
export function __resetArtistIdResolveCacheForTests(): void {
  idByKey.clear();
  queuedByServer = new Map();
  inflightByKey.clear();
  flushHandle = null;
  generation = 0;
  revision = 0;
  retryDelayMs = RETRY_BASE_MS;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  listeners.clear();
}

/**
 * Drop resolved names so they are looked up again.
 *
 * Called when the library index changes: an artist missing during the initial sync is
 * cached as "no artist row", and without this that negative would outlive the sync
 * that created the row, leaving the guest unlinkable until the app restarts.
 *
 * Advancing the generation also retires requests that are still in flight, so a
 * pre-sync answer cannot land after the clear.
 */
export function clearArtistIdResolveCache(): void {
  idByKey.clear();
  generation += 1;
  retryDelayMs = RETRY_BASE_MS;
  notify();
}
