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
 * Errors are never cached, so a transient backend failure stays retryable.
 */
const idByKey = new Map<string, string | null>();

/** Names queued for the next flush, per SQL server id. */
let queuedByServer = new Map<string, Set<string>>();
/** Keys currently in a running request — kept out of the next queue. */
const inflightKeys = new Set<string>();
let flushPromise: Promise<void> | null = null;

/** Backend cap per call (`RESOLVE_ARTIST_IDS_MAX`); chunk deliberately, not by luck. */
const RESOLVE_BATCH_SIZE = 32;

/** Same fold the index stores in `artist.name_fold` (`trim().to_lowercase()`). */
function foldName(name: string): string {
  return name.trim().toLowerCase();
}

function cacheKey(sqlServerId: string, name: string): string {
  return `${sqlServerId}\u0000${foldName(name)}`;
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

async function runBatch(sqlServerId: string, names: string[]): Promise<void> {
  for (let start = 0; start < names.length; start += RESOLVE_BATCH_SIZE) {
    const chunk = names.slice(start, start + RESOLVE_BATCH_SIZE);
    try {
      const res = await commands.libraryResolveArtistIds(sqlServerId, chunk);
      // Only an `ok` result carries answers. An `err` (busy index, poisoned read
      // lock, sync in progress) says nothing about whether these artists exist, so
      // caching it as "no artist row" would make every guest permanently unlinkable.
      if (res.status === 'ok') {
        chunk.forEach((name, index) => {
          idByKey.set(cacheKey(sqlServerId, name), res.data[index] ?? null);
        });
      }
    } catch {
      // Same reasoning as above: leave the names uncached so a later render retries.
    } finally {
      for (const name of chunk) inflightKeys.delete(cacheKey(sqlServerId, name));
    }
  }
}

function scheduleFlush(): Promise<void> {
  if (flushPromise) return flushPromise;
  flushPromise = new Promise<void>(resolve => {
    queueMicrotask(() => {
      const batch = queuedByServer;
      queuedByServer = new Map();
      flushPromise = null;
      void Promise.all(
        [...batch.entries()].map(([sqlServerId, names]) => runBatch(sqlServerId, [...names])),
      ).then(() => resolve());
    });
  });
  return flushPromise;
}

/**
 * Resolve names to artist ids, filling the cache. Already-cached or already-queued
 * names cost nothing. Resolves once the batch containing them has completed — read
 * the values back with {@link peekArtistIdByName}.
 */
export async function resolveArtistIdsByName(
  serverId: string | null | undefined,
  names: ReadonlyArray<string>,
): Promise<void> {
  const server = serverId?.trim();
  if (!server) return;
  const sqlServerId = librarySqlServerId(server);

  let queued = queuedByServer.get(sqlServerId);
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;
    const key = cacheKey(sqlServerId, name);
    if (idByKey.has(key) || inflightKeys.has(key)) continue;
    if (!queued) {
      queued = new Set();
      queuedByServer.set(sqlServerId, queued);
    }
    inflightKeys.add(key);
    queued.add(name);
  }

  await scheduleFlush();
}

/** Test seam — the cache is process-wide and would leak between cases. */
export function __resetArtistIdResolveCacheForTests(): void {
  idByKey.clear();
  queuedByServer = new Map();
  inflightKeys.clear();
  flushPromise = null;
}

/**
 * Drop resolved names so they are looked up again.
 *
 * Called when the library index changes: an artist missing during the initial sync is
 * cached as "no artist row", and without this that negative would outlive the sync
 * that created the row, leaving the guest unlinkable until the app restarts.
 */
export function clearArtistIdResolveCache(): void {
  idByKey.clear();
}
