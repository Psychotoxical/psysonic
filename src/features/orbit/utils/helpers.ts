import {
  ORBIT_PLAYLIST_PREFIX,
  ORBIT_STATE_MAX_BYTES,
  type OrbitOutboxMeta,
  type OrbitQueueItem,
  type OrbitState,
} from '@/features/orbit/api/orbit';

/** 8 lowercase hex chars — unique enough for concurrent-session collision-free naming. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Serialise the state blob for writing into a playlist comment. Emits a
 * plain JSON string. Throws when the output exceeds `ORBIT_STATE_MAX_BYTES`
 * — callers should trim optional fields (oldest queue entries / kicked
 * usernames) and retry, rather than write something truncated.
 */
export function serialiseOrbitState(state: OrbitState): string {
  const json = JSON.stringify(state);
  // Encode-length check — emoji-heavy session names could inflate UTF-8 bytes
  // beyond the string's .length count.
  const byteLen = new TextEncoder().encode(json).length;
  if (byteLen > ORBIT_STATE_MAX_BYTES) {
    throw new OrbitStateTooLarge(byteLen);
  }
  return json;
}

export class OrbitStateTooLarge extends Error {
  constructor(public readonly bytes: number) {
    super(`Orbit state blob (${bytes} bytes) exceeds ${ORBIT_STATE_MAX_BYTES} byte budget`);
    this.name = 'OrbitStateTooLarge';
  }
}

function trySerialise(state: OrbitState): string | null {
  try {
    return serialiseOrbitState(state);
  } catch (e) {
    if (e instanceof OrbitStateTooLarge) return null;
    throw e;
  }
}

/**
 * Serialise the state blob for the wire, shedding the least-important data
 * instead of throwing when it would exceed the byte budget. Without this a
 * single over-budget tick makes `writeOrbitState` throw, the host swallows it
 * and retries the same too-large state forever — guests freeze and time out.
 *
 * Sheds, in order: oldest attribution history (`queue`), then the tail of the
 * published `playQueue`. Operates on copies — the caller's local store keeps
 * full state; only the published blob shrinks, which is all guests consume.
 * If even a minimal blob overflows (pathological session name / participant
 * list) it throws `OrbitStateTooLarge` as before, so the caller still logs.
 */
export function serialiseOrbitStateForWire(state: OrbitState): string {
  const direct = trySerialise(state);
  if (direct !== null) return direct;

  // Drop oldest suggestions first — they're the least useful for attribution.
  const queue = [...state.queue].sort((a, b) => a.addedAt - b.addedAt);
  while (queue.length > 0) {
    queue.shift();
    const out = trySerialise({ ...state, queue });
    if (out !== null) return out;
  }

  // Queue exhausted and still too large — shorten the published play queue.
  const playQueue = [...(state.playQueue ?? [])];
  while (playQueue.length > 0) {
    playQueue.pop();
    const out = trySerialise({ ...state, queue: [], playQueue });
    if (out !== null) return out;
  }

  // Even the minimal blob overflows — surface it so the host tick logs it.
  return serialiseOrbitState({ ...state, queue: [], playQueue: [] });
}

export function serialiseOutboxMeta(meta: OrbitOutboxMeta): string {
  return JSON.stringify(meta);
}

/**
 * Stable per-suggestion key across reshuffles — `addedBy`, `addedAt` and
 * `trackId` are all immutable once the host sweep has written them.
 * Shared between the host tick and the manual-approval UI.
 */
export const suggestionKey = (q: OrbitQueueItem): string =>
  `${q.addedBy}:${q.addedAt}:${q.trackId}`;

/**
 * Wrap an async task so it never runs concurrently with itself. While a run is
 * in flight, further calls do NOT start a second run — they flag a rerun, and
 * exactly one more run fires after the current finishes (any number of
 * mid-flight requests coalesce into a single catch-up). The host tick uses this
 * because `pushState` does several awaited round-trips and is fired from a 2.5 s
 * timer, the mount, and a play/pause subscription that can overlap; without
 * serialisation a slow run that already swept+cleared an outbox can lose its
 * write to a faster run (last-writer-wins), dropping those suggestions.
 */
export function makeCoalescedRunner(task: () => Promise<void>): () => Promise<void> {
  let running = false;
  let rerun = false;
  return async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        await task();
      } while (rerun);
    } finally {
      running = false;
    }
  };
}

/** Extract `<username>` from a filename matching `__psyorbit_<sid>_from_<username>__`. */
export function parseOutboxPlaylistName(name: string, sid: string): string | null {
  const prefix = `${ORBIT_PLAYLIST_PREFIX}${sid}_from_`;
  if (!name.startsWith(prefix) || !name.endsWith('__')) return null;
  const user = name.slice(prefix.length, name.length - 2);
  return user.length > 0 ? user : null;
}
