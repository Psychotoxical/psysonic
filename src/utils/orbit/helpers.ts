import {
  ORBIT_PLAYLIST_PREFIX,
  ORBIT_STATE_MAX_BYTES,
  type OrbitOutboxMeta,
  type OrbitQueueItem,
  type OrbitState,
} from '../../api/orbit';

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

/** Extract `<username>` from a filename matching `__psyorbit_<sid>_from_<username>__`. */
export function parseOutboxPlaylistName(name: string, sid: string): string | null {
  const prefix = `${ORBIT_PLAYLIST_PREFIX}${sid}_from_`;
  if (!name.startsWith(prefix) || !name.endsWith('__')) return null;
  const user = name.slice(prefix.length, name.length - 2);
  return user.length > 0 ? user : null;
}
