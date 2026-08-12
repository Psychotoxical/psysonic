import { setRating, star, unstar } from '@/lib/api/subsonicStarRating';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { patchCachedTrack } from '@/features/playback/store/queueTrackResolver';
import { onActiveServerBecameReachable } from '@/lib/network/activeServerReachability';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import {
  canonicalizeConfirmedNavidromeId,
  canonicalizeNavidromeId,
} from '@/lib/server/navidromeCanonicalIds';

/**
 * F4 — pending-sync for **song** star + rating (spec §6.5 / R7-18).
 *
 * The player-store override maps (`starredOverrides` / `userRatingOverrides`)
 * are *session-only* client truth that every list view merges over its
 * one-shot-fetched state:
 *
 * 1. Set the override optimistically (instant UI).
 * 2. Retry the Subsonic API (`star` / `unstar` / `setRating`) with exponential
 *    backoff; flush immediately when the active server becomes reachable again
 *    (`onActiveServerBecameReachable`) or on window focus.
 * 3. On **star** success: KEEP the override — list views read it — and patch
 *    the in-memory `Track`. F3 index patch-on-use runs in the API layer.
 *    (Ratings clear on success; see `onRatingSuccess`.)
 * 4. On app restart before success: the pending change is lost — acceptable,
 *    overrides are not persisted.
 *
 * **No rollback on the first network error** (this replaces the per-component
 * star rollback). v1 routes **songs only**; album/artist stay on their existing
 * paths.
 */

type Task =
  | { kind: 'star'; id: string; starred: boolean; serverId?: string; overrideKey: string; sequence: number }
  | { kind: 'rating'; id: string; rating: number; serverId?: string; overrideKey: string; sequence: number };

const pending = new Map<string, Task>(); // key `${kind}:${id}` — latest wins
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const attempts = new Map<string, number>();
const latestSequenceByKey = new Map<string, number>();
const runningOperations = new Set<string>();
const MAX_BACKOFF_MS = 30_000;
let listenersArmed = false;
let nextSequence = 0;

const keyOf = (t: Task) =>
  `${t.kind}:${t.serverId ?? ''}:${t.id}`;

const operationKeyOf = (t: Task) =>
  `${t.kind}:${t.serverId ?? ''}:${t.serverId ? canonicalizeNavidromeId(t.id) : t.id}`;

function armListeners(): void {
  if (listenersArmed || typeof window === 'undefined') return;
  listenersArmed = true;
  const flushAll = () => {
    for (const k of pending.keys()) schedule(k, 0);
  };
  window.addEventListener('focus', flushAll);
  onActiveServerBecameReachable(flushAll);
}

function schedule(k: string, delayMs: number): void {
  const existing = timers.get(k);
  if (existing) clearTimeout(existing);
  timers.set(
    k,
    setTimeout(() => {
      void run(k);
    }, delayMs),
  );
}

function normalizeTask(k: string, task: Task): { key: string; task: Task } | null {
  const activeId = task.serverId
    ? canonicalizeConfirmedNavidromeId(task.serverId, task.id)
    : task.id;
  const activeOverrideKey = task.serverId
    ? ownedEntityKey({ id: activeId, serverId: task.serverId })
    : task.overrideKey;
  if (activeId === task.id && activeOverrideKey === task.overrideKey) return { key: k, task };

  const activeTask = { ...task, id: activeId, overrideKey: activeOverrideKey } as Task;
  const activeKey = keyOf(activeTask);
  const latestSequence = latestSequenceByKey.get(activeKey) ?? 0;
  if (latestSequence > task.sequence) {
    pending.delete(k);
    attempts.delete(k);
    migrateOverride(task.overrideKey, activeOverrideKey, task.kind, false);
    return null;
  }
  latestSequenceByKey.set(activeKey, Math.max(latestSequence, task.sequence));
  const current = pending.get(activeKey);
  if (current && current !== task) {
    pending.delete(k);
    attempts.delete(k);
    migrateOverride(task.overrideKey, activeOverrideKey, task.kind, false);
    return null;
  }
  pending.delete(k);
  pending.set(activeKey, activeTask);
  const attempt = attempts.get(k);
  attempts.delete(k);
  if (attempt !== undefined) attempts.set(activeKey, attempt);
  migrateOverride(task.overrideKey, activeOverrideKey, task.kind, true);
  return { key: activeKey, task: activeTask };
}

async function run(k: string): Promise<void> {
  timers.delete(k);
  let task = pending.get(k);
  if (!task) return;
  const operationKey = operationKeyOf(task);
  if (runningOperations.has(operationKey)) return;
  runningOperations.add(operationKey);
  const normalized = normalizeTask(k, task);
  if (!normalized) {
    runningOperations.delete(operationKey);
    return;
  }
  k = normalized.key;
  task = normalized.task;
  const startedSequence = task.sequence;
  try {
    if (task.kind === 'star') {
      const meta = task.serverId ? { serverId: task.serverId } : undefined;
      if (task.starred) await star(task.id, 'song', meta);
      else await unstar(task.id, 'song', meta);
      const after = normalizeTask(k, task);
      if (!after || after.task.kind !== 'star') return;
      k = after.key;
      task = after.task;
      if (pending.get(k) !== task) return;
      onStarSuccess(task);
    } else {
      if (task.serverId) await setRating(task.id, task.rating, { serverId: task.serverId });
      else await setRating(task.id, task.rating);
      const after = normalizeTask(k, task);
      if (!after || after.task.kind !== 'rating') return;
      k = after.key;
      task = after.task;
      if (pending.get(k) !== task) return;
      onRatingSuccess(task);
    }
    // Only retire the entry if a newer toggle hasn't superseded it mid-flight.
    if (pending.get(k) === task) {
      pending.delete(k);
      attempts.delete(k);
    }
  } catch {
    if (pending.get(k) !== task) return; // superseded — the newer task self-schedules
    const n = (attempts.get(k) ?? 0) + 1;
    attempts.set(k, n);
    schedule(k, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (n - 1)));
  } finally {
    runningOperations.delete(operationKey);
    const latest = [...pending.entries()].find(([, candidate]) =>
      operationKeyOf(candidate) === operationKey && candidate.sequence > startedSequence,
    );
    if (latest) schedule(latest[0], 0);
  }
}

function migrateOverride(from: string, to: string, kind: Task['kind'], overwrite: boolean): void {
  if (from === to) return;
  usePlayerStore.setState(state => {
    const field = kind === 'star' ? 'starredOverrides' : 'userRatingOverrides';
    const overrides = state[field];
    if (!(from in overrides)) return {};
    const next = { ...overrides };
    if (overwrite || !(to in next)) next[to] = overrides[from];
    delete next[from];
    return { [field]: next };
  });
}

function onStarSuccess(task: Extract<Task, { kind: 'star' }>): void {
  const starredVal = task.starred ? new Date().toISOString() : undefined;
  // Keep the override — list views merge it (step 3 atop this file).
  usePlayerStore.setState(s => ({
    currentTrack:
      s.currentTrack?.id === task.id
        && (!task.serverId || !s.currentTrack.serverId || s.currentTrack.serverId === task.serverId)
        ? { ...s.currentTrack, starred: starredVal }
        : s.currentTrack,
  }));
  // Thin-state: the queue's copy lives in the resolver cache. Patch it in place
  // to the synced value rather than dropping it — a dropped entry would blank the
  // visible queue row to a "…" placeholder until the next window re-resolve.
  patchCachedTrack(task.id, { starred: starredVal }, task.serverId ?? '');
}

function onRatingSuccess(task: Extract<Task, { kind: 'rating' }>): void {
  const rating = usePlayerStore.getState().userRatingOverrides[task.overrideKey];
  usePlayerStore.setState(s => {
    if (!(task.overrideKey in s.userRatingOverrides)) return {};
    const next = { ...s.userRatingOverrides };
    delete next[task.overrideKey];
    return { userRatingOverrides: next };
  });
  // Patch the cached queue track in place (see onStarSuccess) so the row keeps
  // its title and shows the synced rating without flashing a placeholder.
  if (rating !== undefined) {
    patchCachedTrack(task.id, { userRating: rating }, task.serverId ?? '');
  }
}

/** Optimistically (un)star a song and sync it to the server with retry. */
export function queueSongStar(
  id: string,
  starred: boolean,
  serverId?: string,
  options?: { scopedOverride?: boolean },
): void {
  if (serverId) id = canonicalizeConfirmedNavidromeId(serverId, id);
  const scopedOverride = options?.scopedOverride ?? Boolean(serverId);
  const overrideKey = scopedOverride ? ownedEntityKey({ id, serverId }) : id;
  usePlayerStore.getState().setStarredOverride(overrideKey, starred);
  const t: Task = { kind: 'star', id, starred, serverId, overrideKey, sequence: ++nextSequence };
  const k = keyOf(t);
  latestSequenceByKey.set(k, t.sequence);
  pending.set(k, t);
  attempts.delete(k);
  armListeners();
  schedule(k, 0);
}

/** Optimistically rate a song and sync it to the server with retry. */
export function queueSongRating(
  id: string,
  rating: number,
  serverId?: string,
  options?: { scopedOverride?: boolean },
): void {
  if (serverId) id = canonicalizeConfirmedNavidromeId(serverId, id);
  const scopedOverride = options?.scopedOverride ?? Boolean(serverId);
  const overrideKey = scopedOverride ? ownedEntityKey({ id, serverId }) : id;
  usePlayerStore.getState().setUserRatingOverride(overrideKey, rating);
  const t: Task = { kind: 'rating', id, rating, serverId, overrideKey, sequence: ++nextSequence };
  const k = keyOf(t);
  latestSequenceByKey.set(k, t.sequence);
  pending.set(k, t);
  attempts.delete(k);
  armListeners();
  schedule(k, 0);
}

/** Test-only: clear all pending state + timers. */
export function _resetPendingStarSyncForTest(): void {
  pending.clear();
  attempts.clear();
  latestSequenceByKey.clear();
  runningOperations.clear();
  nextSequence = 0;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
