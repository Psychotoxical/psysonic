// Resolve on-disk local playback bytes/URLs for a track across the legacy UUID /
// URL index-key variants. Pure substrate over authStore + localPlaybackStore —
// holds no offline-feature state (no useOfflineStore), so the audio core can
// depend on it without inverting into @/features/offline.
import { useAuthStore } from '@/store/authStore';
import type { LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';

function serverIndexKeysForServerId(serverId: string): string[] {
  const servers = useAuthStore.getState().servers;
  const server = servers.find(s => s.id === serverId);
  const keys = new Set<string>();
  if (server) {
    const profileKey = serverIndexKeyForProfile(server);
    if (profileKey) keys.add(profileKey);
    keys.add(server.id);
  }
  keys.add(resolveIndexKey(serverId));
  keys.add(serverId);
  return [...keys].filter(Boolean);
}

export function entryBelongsToServer(entry: LocalPlaybackEntry, serverId: string): boolean {
  return serverIndexKeysForServerId(serverId).includes(entry.serverIndexKey);
}

export function indexKeyBelongsToServer(serverIndexKey: string, serverId: string): boolean {
  return serverIndexKeysForServerId(serverId).includes(serverIndexKey);
}

/** Resolve a library-tier row across legacy UUID / URL index-key variants. */
export function findLocalPlaybackEntry(
  trackId: string,
  serverId: string,
): LocalPlaybackEntry | null {
  const lp = useLocalPlaybackStore.getState();
  for (const key of serverIndexKeysForServerId(serverId)) {
    const hit = lp.getEntry(trackId, key);
    if (hit?.tier === 'library') return hit;
  }
  for (const entry of Object.values(lp.entries)) {
    if (entry.trackId !== trackId || entry.tier !== 'library') continue;
    if (entryBelongsToServer(entry, serverId)) return entry;
  }
  return null;
}

/** Index cache; run {@link reconcileLibraryTierForAlbum} / server reconcile so rows match disk. */
export function hasLocalLibraryBytes(trackId: string, serverId: string): boolean {
  return !!findLocalPlaybackEntry(trackId, serverId)?.localPath;
}

/** Resolve a `favorite-auto` tier row across index-key variants. */
export function findFavoriteAutoEntry(
  trackId: string,
  serverId: string,
): LocalPlaybackEntry | null {
  const lp = useLocalPlaybackStore.getState();
  for (const key of serverIndexKeysForServerId(serverId)) {
    const hit = lp.getEntry(trackId, key);
    if (hit?.tier === 'favorite-auto') return hit;
  }
  for (const entry of Object.values(lp.entries)) {
    if (entry.trackId !== trackId || entry.tier !== 'favorite-auto') continue;
    if (entryBelongsToServer(entry, serverId)) return entry;
  }
  return null;
}

export function hasLocalFavoriteAutoBytes(trackId: string, serverId: string): boolean {
  return !!findFavoriteAutoEntry(trackId, serverId)?.localPath;
}

/** Resolve an `ephemeral` (hot-cache) tier row across index-key variants. */
export function findEphemeralEntry(
  trackId: string,
  serverId: string,
): LocalPlaybackEntry | null {
  const lp = useLocalPlaybackStore.getState();
  for (const key of serverIndexKeysForServerId(serverId)) {
    const hit = lp.getEntry(trackId, key);
    if (hit?.tier === 'ephemeral') return hit;
  }
  for (const entry of Object.values(lp.entries)) {
    if (entry.trackId !== trackId || entry.tier !== 'ephemeral') continue;
    if (entryBelongsToServer(entry, serverId)) return entry;
  }
  return null;
}

/**
 * Whether a hot-cache (ephemeral) blob may be reused for the current streaming
 * quality. A blob captured from a capped live stream carries the cap it was
 * fetched at; it may only be reused when that matches the current request.
 * Original (0/undefined) blobs satisfy any request. Unknown (no entry) is
 * treated as original so non-hot-cache callers are unaffected.
 */
export function ephemeralServeableAtQuality(
  trackId: string,
  serverId: string,
  currentMaxBitRateKbps: number,
): boolean {
  const cachedCap = findEphemeralEntry(trackId, serverId)?.streamMaxBitRateKbps ?? 0;
  return cachedCap === 0 || cachedCap === currentMaxBitRateKbps;
}

/** Manual offline library or favorites auto-sync — skip redundant hot-cache prefetch/promote. */
export function hasLocalPersistentPlaybackBytes(trackId: string, serverId: string): boolean {
  return hasLocalLibraryBytes(trackId, serverId) || hasLocalFavoriteAutoBytes(trackId, serverId);
}

/** Resolve `psysonic-local://` across legacy UUID / host index-key variants. */
export function findLocalPlaybackUrl(
  trackId: string,
  serverId: string,
  tier: 'library' | 'ephemeral' | 'favorite-auto',
): string | null {
  if (tier === 'library') {
    const entry = findLocalPlaybackEntry(trackId, serverId);
    if (entry?.localPath) return `psysonic-local://${entry.localPath}`;
    return null;
  }
  if (tier === 'favorite-auto') {
    const entry = findFavoriteAutoEntry(trackId, serverId);
    if (entry?.localPath) return `psysonic-local://${entry.localPath}`;
    return null;
  }
  const lp = useLocalPlaybackStore.getState();
  for (const key of serverIndexKeysForServerId(serverId)) {
    const url = lp.getLocalUrl(trackId, key, 'ephemeral');
    if (url) return url;
  }
  return null;
}

/**
 * True when the track resolves to local `psysonic-local://` bytes (library,
 * favorite-auto, or ephemeral tier). Mirrors `resolvePlaybackUrl`'s local-source
 * branch exactly (same `resolveServerIdForIndexKey(serverId) || serverId` profile
 * resolution, minus the empty-serverId playback-store fallback that callers here
 * never hit) so the network-guard skip check stays bit-identical without an
 * @/features/playback import.
 */
export function hasLocalPlaybackUrl(trackId: string, serverId: string): boolean {
  const profileId = resolveServerIdForIndexKey(serverId) || serverId;
  return !!(
    findLocalPlaybackUrl(trackId, profileId, 'library') ||
    findLocalPlaybackUrl(trackId, profileId, 'favorite-auto') ||
    findLocalPlaybackUrl(trackId, profileId, 'ephemeral')
  );
}
