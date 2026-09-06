import { canonicalNavidromeArtworkId, canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';

const AUTH_KEY = 'psysonic-auth';
const PLAYER_KEY = 'psysonic-player';
const SHUFFLE_KEY = 'psysonic_shuffle_mode';
const LOCAL_PLAYBACK_KEY = 'psysonic-local-playback';
const OFFLINE_KEY = 'psysonic-offline';
const HOT_CACHE_KEY = 'psysonic-hot-cache';
const LOCAL_PLAYBACK_MIGRATED_KEY = 'psysonic-local-playback-migrated-v1';
const DEVICE_SYNC_KEY = 'psysonic_device_sync';
const PLAYLIST_KEY = 'psysonic_playlists_recent';
const PLAYLIST_FOLDERS_KEY = 'psysonic_playlist_folders';
const RADIO_KEYS = ['psysonic_radio_favorites', 'psysonic_radio_order'] as const;
const NEW_RELEASES_PREFIX = 'psy_new_releases_unread_seen_v2:';
const INVALIDATED_PREFIXES = [
  'psysonic_because_anchor_history:',
  'psysonic_because_picks:',
] as const;

type JsonObject = Record<string, unknown>;

export type NavidromeCanonicalFrontendScope = {
  serverIndexKey: string;
  profileIds: string[];
  profileServerIndexKeys: Record<string, string>;
};

export type NavidromeCanonicalFrontendStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`Malformed persisted state in ${label}`);
  return value;
}

function readJson(storage: NavidromeCanonicalFrontendStorage, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Malformed persisted state in ${key}`);
  }
}

function writeJson(
  storage: NavidromeCanonicalFrontendStorage,
  key: string,
  value: unknown,
): void {
  const serialized = JSON.stringify(value);
  storage.setItem(key, serialized);
  const readBack = storage.getItem(key);
  if (readBack === null) throw new Error(`Persisted state write failed for ${key}`);
  try {
    if (JSON.stringify(JSON.parse(readBack) as unknown) !== serialized) {
      throw new Error(`Persisted state readback mismatch for ${key}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('readback mismatch')) throw error;
    const wrapped = new Error(`Persisted state readback failed for ${key}`) as Error & { cause?: unknown };
    wrapped.cause = error;
    throw wrapped;
  }
}

function writeMarker(storage: NavidromeCanonicalFrontendStorage, key: string, value: string): void {
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error(`Persisted marker readback mismatch for ${key}`);
}

function canonicalId(value: unknown): unknown {
  return typeof value === 'string' ? canonicalNavidromeId(value) : value;
}

function canonicalArtwork(value: unknown): unknown {
  return typeof value === 'string' ? canonicalNavidromeArtworkId(value) : value;
}

function ownerSet(scope: NavidromeCanonicalFrontendScope): Set<string> {
  return new Set([scope.serverIndexKey, ...scope.profileIds]);
}

function ownerMatches(value: unknown, owners: ReadonlySet<string>): boolean {
  return typeof value === 'string' && owners.has(value);
}

function resolveOwnerServerIndexKey(
  value: unknown,
  scope: NavidromeCanonicalFrontendScope,
): string | null {
  if (typeof value !== 'string' || !value) return null;
  return scope.profileServerIndexKeys[value]
    ?? (Object.values(scope.profileServerIndexKeys).includes(value) ? value : null);
}

function rewriteArtistRefs(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(raw => {
    if (!isObject(raw)) return raw;
    return { ...raw, id: canonicalId(raw.id) };
  });
}

function rewriteTrack(value: unknown, label: string): unknown {
  const track = asObject(value, label);
  const next: JsonObject = {
    ...track,
    id: canonicalId(track.id),
    albumId: canonicalId(track.albumId),
    artistId: canonicalId(track.artistId),
    artists: rewriteArtistRefs(track.artists),
    coverArt: canonicalArtwork(track.coverArt),
  };
  if (Array.isArray(track.albumArtists)) next.albumArtists = rewriteArtistRefs(track.albumArtists);
  if (Array.isArray(track.contributors)) {
    next.contributors = track.contributors.map(raw => {
      if (!isObject(raw) || !isObject(raw.artist)) return raw;
      return { ...raw, artist: { ...raw.artist, id: canonicalId(raw.artist.id) } };
    });
  }
  return next;
}

function rewriteFolderList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const rewritten: unknown[] = [];
  const indexById = new Map<string, number>();
  for (const raw of value) {
    const folder = isObject(raw) ? { ...raw, id: canonicalId(raw.id) } : raw;
    if (!isObject(folder) || typeof folder.id !== 'string') {
      rewritten.push(folder);
      continue;
    }
    const existingIndex = indexById.get(folder.id);
    if (existingIndex === undefined) {
      indexById.set(folder.id, rewritten.length);
      rewritten.push(folder);
      continue;
    }
    const existing = rewritten[existingIndex];
    rewritten[existingIndex] = isObject(existing)
      ? mergeCompleteObjects(existing, folder)
      : folder;
  }
  return rewritten;
}

function rewriteStringList(value: unknown): unknown {
  return Array.isArray(value) ? [...new Set(value.map(canonicalId))] : value;
}

function rewriteAuthState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const raw = readJson(storage, AUTH_KEY);
  if (raw === null) return;
  const root = asObject(raw, AUTH_KEY);
  const state = asObject(root.state, AUTH_KEY);
  const affectedOwners = ownerSet(scope);
  const profileIds = new Set(scope.profileIds);

  for (const field of ['musicFoldersByServer', 'libraryBrowseSelectionByServer', 'musicLibrarySelectionByServer'] as const) {
    if (!isObject(state[field])) continue;
    const next = { ...state[field] };
    for (const owner of affectedOwners) {
      if (!(owner in next)) continue;
      next[owner] = field === 'musicFoldersByServer'
        ? rewriteFolderList(next[owner])
        : rewriteStringList(next[owner]);
    }
    state[field] = next;
  }

  if (isObject(state.musicLibraryFilterByServer)) {
    const next = { ...state.musicLibraryFilterByServer };
    for (const owner of affectedOwners) {
      const value = next[owner];
      if (typeof value === 'string' && value !== 'all') next[owner] = canonicalNavidromeId(value);
    }
    state.musicLibraryFilterByServer = next;
  }

  if (ownerMatches(state.activeServerId, profileIds)) {
    state.musicFolders = rewriteFolderList(state.musicFolders);
  }

  if (isObject(state.skipStarManualSkipCountsByKey)) {
    const counters: Record<string, number> = {};
    for (const [key, rawCount] of Object.entries(state.skipStarManualSkipCountsByKey)) {
      const separator = key.indexOf('\u001f');
      if (separator <= 0 || separator === key.length - 1 || typeof rawCount !== 'number' || !Number.isFinite(rawCount)) {
        continue;
      }
      const owner = key.slice(0, separator);
      const trackId = key.slice(separator + 1);
      const resolvedOwner = scope.profileServerIndexKeys[owner]
        ?? (Object.values(scope.profileServerIndexKeys).includes(owner) ? owner : null);
      if (!resolvedOwner) continue;
      const rewritten = resolvedOwner === scope.serverIndexKey
        ? `${owner}\u001f${canonicalNavidromeId(trackId)}`
        : key;
      counters[rewritten] = Math.max(counters[rewritten] ?? 0, rawCount);
    }
    state.skipStarManualSkipCountsByKey = counters;
  }

  writeJson(storage, AUTH_KEY, { ...root, state });
}

function rewritePlayerState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): string | null {
  const raw = readJson(storage, PLAYER_KEY);
  if (raw === null) return null;
  const root = asObject(raw, PLAYER_KEY);
  const state = asObject(root.state, PLAYER_KEY);
  const owners = ownerSet(scope);
  const queueOwner = typeof state.queueServerId === 'string' ? state.queueServerId : null;
  if (state.currentTrack !== null && state.currentTrack !== undefined) {
    const current = asObject(state.currentTrack, PLAYER_KEY);
    if (ownerMatches(current.serverId, owners) || (!current.serverId && ownerMatches(queueOwner, owners))) {
      state.currentTrack = rewriteTrack(current, PLAYER_KEY);
    }
  }
  if (Array.isArray(state.queueItems)) {
    state.queueItems = state.queueItems.map(rawItem => {
      if (!isObject(rawItem) || !ownerMatches(rawItem.serverId, owners)) return rawItem;
      return { ...rawItem, trackId: canonicalId(rawItem.trackId) };
    });
  }
  if (Array.isArray(state.queueRefs) && ownerMatches(queueOwner, owners)) {
    state.queueRefs = state.queueRefs.map(canonicalId);
  }
  if (Array.isArray(state.queue) && ownerMatches(queueOwner, owners)) {
    state.queue = state.queue.map(track => rewriteTrack(track, PLAYER_KEY));
  }
  writeJson(storage, PLAYER_KEY, { ...root, state });
  return queueOwner;
}

function rewriteShuffleState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
  queueOwner: string | null,
): void {
  const raw = readJson(storage, SHUFFLE_KEY);
  if (raw === null) return;
  const snapshot = asObject(raw, SHUFFLE_KEY);
  if (!Array.isArray(snapshot.originalOrder)) return;
  const owners = ownerSet(scope);
  snapshot.originalOrder = snapshot.originalOrder.map(value => {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 2 || !ownerMatches(parsed[0], owners) || typeof parsed[1] !== 'string') {
        return value;
      }
      return JSON.stringify([parsed[0], canonicalNavidromeId(parsed[1])]);
    } catch {
      return ownerMatches(queueOwner, owners) ? canonicalNavidromeId(value) : value;
    }
  });
  writeJson(storage, SHUFFLE_KEY, snapshot);
}

function rewritePinSource(value: unknown): unknown {
  return isObject(value)
    ? { ...value, sourceId: canonicalId(value.sourceId) }
    : value;
}

function rewriteFlatLegacyPath(value: unknown, oldId: string, newId: string): unknown {
  if (typeof value !== 'string' || oldId === newId) return value;
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const prefix = value.slice(0, separator + 1);
  const filename = value.slice(separator + 1);
  return filename.startsWith(`${oldId}.`) ? `${prefix}${newId}${filename.slice(oldId.length)}` : value;
}

function sourceKey(value: unknown): string | null {
  if (!isObject(value) || typeof value.kind !== 'string' || typeof value.sourceId !== 'string') return null;
  return `${value.kind}:${value.sourceId}`;
}

function mergePinSources(...values: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  for (const value of values.flatMap(item => Array.isArray(item) ? item : item ? [item] : [])) {
    const key = sourceKey(value);
    if (key) merged.set(key, value);
  }
  return [...merged.values()];
}

function mergeLocalPlaybackEntries(existing: JsonObject, candidate: JsonObject, key: string): JsonObject {
  if (existing.localPath !== candidate.localPath) {
    throw new Error(`Local playback collision at ${key}`);
  }
  const priority = { ephemeral: 0, 'favorite-auto': 1, library: 2 } as Record<string, number>;
  const existingRank = priority[String(existing.tier)] ?? -1;
  const candidateRank = priority[String(candidate.tier)] ?? -1;
  const existingStamp = typeof existing.cachedAt === 'number' ? existing.cachedAt : 0;
  const candidateStamp = typeof candidate.cachedAt === 'number' ? candidate.cachedAt : 0;
  const winner = candidateRank > existingRank || (candidateRank === existingRank && candidateStamp > existingStamp)
    ? candidate
    : existing;
  const other = winner === existing ? candidate : existing;
  const sources = mergePinSources(
    winner.pinSource,
    winner.pinSources,
    other.pinSource,
    other.pinSources,
  );
  return {
    ...other,
    ...winner,
    lastPlayedAt: Math.max(
      typeof existing.lastPlayedAt === 'number' ? existing.lastPlayedAt : 0,
      typeof candidate.lastPlayedAt === 'number' ? candidate.lastPlayedAt : 0,
    ) || undefined,
    pinSource: sources[0],
    pinSources: sources.length > 1 ? sources : undefined,
  };
}

function fieldIsComplete(field: unknown): boolean {
  return field !== null
    && field !== undefined
    && field !== ''
    && (!Array.isArray(field) || field.length > 0);
}

function completeFieldCount(value: JsonObject): number {
  return Object.values(value).filter(fieldIsComplete).length;
}

function mergeCompleteObjects(existing: JsonObject, candidate: JsonObject): JsonObject {
  const winner = completeFieldCount(candidate) > completeFieldCount(existing) ? candidate : existing;
  const other = winner === existing ? candidate : existing;
  const merged = { ...other };
  for (const [key, value] of Object.entries(winner)) {
    if (fieldIsComplete(value) || !(key in merged)) merged[key] = value;
  }
  return merged;
}

function mergeLegacyImportedEntry(existing: JsonObject, candidate: JsonObject, key: string): JsonObject {
  if (existing.localPath !== candidate.localPath) {
    throw new Error(`Local playback collision at ${key}`);
  }
  if (existing.tier !== 'library') return mergeLocalPlaybackEntries(existing, candidate, key);
  const sources = mergePinSources(
    existing.pinSource,
    existing.pinSources,
    candidate.pinSource,
    candidate.pinSources,
  );
  return {
    ...candidate,
    ...existing,
    lastPlayedAt: Math.max(
      typeof existing.lastPlayedAt === 'number' ? existing.lastPlayedAt : 0,
      typeof candidate.lastPlayedAt === 'number' ? candidate.lastPlayedAt : 0,
    ) || undefined,
    pinSource: sources[0],
    pinSources: sources.length > 1 ? sources : undefined,
  };
}

function splitKnownOwnerKey(
  value: string,
  scope: NavidromeCanonicalFrontendScope,
): [owner: string, id: string] | null {
  const owners = [...new Set([
    ...Object.keys(scope.profileServerIndexKeys),
    ...Object.values(scope.profileServerIndexKeys),
  ])].sort((left, right) => right.length - left.length);
  for (const owner of owners) {
    const prefix = `${owner}:`;
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return [owner, value.slice(prefix.length)];
    }
  }
  return null;
}

function rewriteOwnedEntityKey(
  value: string,
  scope: NavidromeCanonicalFrontendScope,
): string {
  const parts = splitKnownOwnerKey(value, scope);
  if (!parts || resolveOwnerServerIndexKey(parts[0], scope) !== scope.serverIndexKey) return value;
  return `${parts[0]}:${canonicalNavidromeId(parts[1])}`;
}

function legacyPinSourcesForTrack(
  serverIndexKey: string,
  trackId: string,
  albums: JsonObject,
  scope: NavidromeCanonicalFrontendScope,
): JsonObject[] {
  const sources = new Map<string, JsonObject>();
  for (const rawAlbum of Object.values(albums)) {
    if (!isObject(rawAlbum)
      || resolveOwnerServerIndexKey(rawAlbum.serverId, scope) !== serverIndexKey
      || !Array.isArray(rawAlbum.trackIds)
      || !rawAlbum.trackIds.includes(trackId)
      || typeof rawAlbum.id !== 'string') continue;
    const kind = offlineKind(rawAlbum.type);
    const source = {
      kind,
      sourceId: rawAlbum.id,
      ...(typeof rawAlbum.name === 'string' ? { displayName: rawAlbum.name } : {}),
    };
    sources.set(`${kind}:${rawAlbum.id}`, source);
  }
  return [...sources.values()];
}

function mergeLegacyLocalPlaybackSources(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const localRaw = readJson(storage, LOCAL_PLAYBACK_KEY);
  const localRoot = localRaw === null ? { state: { entries: {} }, version: 1 } : asObject(localRaw, LOCAL_PLAYBACK_KEY);
  const localState = asObject(localRoot.state, LOCAL_PLAYBACK_KEY);
  const entries = isObject(localState.entries) ? { ...localState.entries } : {};
  let changed = false;

  const offlineRaw = readJson(storage, OFFLINE_KEY);
  if (offlineRaw !== null) {
    const offlineState = asObject(asObject(offlineRaw, OFFLINE_KEY).state, OFFLINE_KEY);
    const tracks = isObject(offlineState.tracks) ? offlineState.tracks : {};
    const albums = isObject(offlineState.albums) ? offlineState.albums : {};
    for (const [persistedKey, rawTrack] of Object.entries(tracks)) {
      const track = asObject(rawTrack, OFFLINE_KEY);
      const keyParts = splitKnownOwnerKey(persistedKey, scope);
      const serverIndexKey = resolveOwnerServerIndexKey(track.serverId, scope)
        ?? resolveOwnerServerIndexKey(keyParts?.[0], scope);
      const trackId = typeof track.id === 'string' ? track.id : keyParts?.[1];
      if (!serverIndexKey || !trackId || typeof track.localPath !== 'string' || !track.localPath) continue;
      const pinSources = legacyPinSourcesForTrack(serverIndexKey, trackId, albums, scope);
      const candidate: JsonObject = {
        serverIndexKey,
        trackId,
        localPath: track.localPath,
        layoutFingerprint: '',
        sizeBytes: 0,
        tier: 'library',
        cachedAt: typeof track.cachedAt === 'string' ? Date.parse(track.cachedAt) || nowForMigration() : nowForMigration(),
        pinSource: pinSources[0],
        pinSources: pinSources.length > 1 ? pinSources : undefined,
        suffix: typeof track.suffix === 'string' && track.suffix ? track.suffix : 'mp3',
        originalBytesVerified: false,
      };
      const key = `${serverIndexKey}:${trackId}`;
      entries[key] = isObject(entries[key])
        ? mergeLegacyImportedEntry(entries[key], candidate, key)
        : candidate;
      changed = true;
    }
  }

  if (changed || localRaw !== null) {
    localState.entries = entries;
    writeJson(storage, LOCAL_PLAYBACK_KEY, { ...localRoot, state: localState, version: 1 });
  }
}

function nowForMigration(): number {
  return Date.now();
}

function rewriteLocalPlaybackState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const raw = readJson(storage, LOCAL_PLAYBACK_KEY);
  if (raw === null) return;
  const root = asObject(raw, LOCAL_PLAYBACK_KEY);
  const state = asObject(root.state, LOCAL_PLAYBACK_KEY);
  if (!isObject(state.entries)) return;
  const entries: Record<string, JsonObject> = {};
  for (const [persistedKey, rawEntry] of Object.entries(state.entries)) {
    const entry = asObject(rawEntry, LOCAL_PLAYBACK_KEY);
    const oldTrackId = typeof entry.trackId === 'string' ? entry.trackId : '';
    const rawOwner = typeof entry.serverIndexKey === 'string' ? entry.serverIndexKey : '';
    if (!rawOwner || !oldTrackId) {
      throw new Error(`Malformed persisted state in ${LOCAL_PLAYBACK_KEY}`);
    }
    const resolvedOwner = resolveOwnerServerIndexKey(entry.serverIndexKey, scope);
    if (!resolvedOwner) {
      entries[persistedKey] = entry;
      continue;
    }
    const affected = resolvedOwner === scope.serverIndexKey;
    const newTrackId = affected ? canonicalNavidromeId(oldTrackId) : oldTrackId;
    const next = affected ? {
      ...entry,
      serverIndexKey: scope.serverIndexKey,
      trackId: newTrackId,
      localPath: rewriteFlatLegacyPath(entry.localPath, oldTrackId, newTrackId),
      pinSource: rewritePinSource(entry.pinSource),
      pinSources: Array.isArray(entry.pinSources) ? entry.pinSources.map(rewritePinSource) : entry.pinSources,
    } : entry;
    if (typeof next.serverIndexKey !== 'string' || typeof next.trackId !== 'string') {
      throw new Error(`Malformed persisted state in ${LOCAL_PLAYBACK_KEY}`);
    }
    const key = `${next.serverIndexKey}:${next.trackId}`;
    entries[key] = entries[key] ? mergeLocalPlaybackEntries(entries[key], next, key) : next;
  }
  state.entries = entries;
  writeJson(storage, LOCAL_PLAYBACK_KEY, { ...root, state });
}

function offlineKind(value: unknown): 'artist' | 'album' | 'track' | 'playlist' {
  return value === 'artist' || value === 'track' || value === 'playlist' ? value : 'album';
}

function rewriteOfflineState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const raw = readJson(storage, OFFLINE_KEY);
  if (raw === null) return;
  const root = asObject(raw, OFFLINE_KEY);
  const state = asObject(root.state, OFFLINE_KEY);
  if (isObject(state.tracks)) {
    const tracks: Record<string, JsonObject> = {};
    for (const [persistedKey, rawMeta] of Object.entries(state.tracks)) {
      const meta = asObject(rawMeta, OFFLINE_KEY);
      const keyParts = splitKnownOwnerKey(persistedKey, scope);
      const resolvedOwner = resolveOwnerServerIndexKey(meta.serverId, scope)
        ?? resolveOwnerServerIndexKey(keyParts?.[0], scope);
      const oldTrackId = typeof meta.id === 'string' ? meta.id : keyParts?.[1];
      if (!oldTrackId || typeof meta.serverId !== 'string') {
        throw new Error(`Malformed persisted state in ${OFFLINE_KEY}`);
      }
      if (!resolvedOwner) {
        tracks[persistedKey] = meta;
        continue;
      }
      const affected = resolvedOwner === scope.serverIndexKey;
      const newTrackId = affected ? canonicalNavidromeId(oldTrackId) : oldTrackId;
      const next = affected ? {
        ...meta,
        id: newTrackId,
        serverId: scope.serverIndexKey,
        albumId: canonicalId(meta.albumId),
        artistId: canonicalId(meta.artistId),
        coverArt: canonicalArtwork(meta.coverArt),
        localPath: rewriteFlatLegacyPath(meta.localPath, oldTrackId, newTrackId),
      } : meta;
      const key = `${next.serverId}:${next.id}`;
      const existing = tracks[key];
      if (existing && existing.localPath !== next.localPath) {
        throw new Error(`Offline track collision at ${key}`);
      }
      const existingStamp = typeof existing?.cachedAt === 'string' ? Date.parse(existing.cachedAt) : 0;
      const nextStamp = typeof next.cachedAt === 'string' ? Date.parse(next.cachedAt) : 0;
      tracks[key] = existing && existingStamp > nextStamp ? existing : { ...existing, ...next };
    }
    state.tracks = tracks;
  }

  if (!isObject(state.albums)) {
    writeJson(storage, OFFLINE_KEY, { ...root, state });
    return;
  }
  const ordered = Object.entries(state.albums).sort(([, left], [, right]) => {
    const leftMeta = isObject(left) ? left : {};
    const rightMeta = isObject(right) ? right : {};
    const leftCanonical = typeof leftMeta.id === 'string' && canonicalNavidromeId(leftMeta.id) === leftMeta.id;
    const rightCanonical = typeof rightMeta.id === 'string' && canonicalNavidromeId(rightMeta.id) === rightMeta.id;
    return Number(rightCanonical) - Number(leftCanonical);
  });
  const albums: Record<string, JsonObject> = {};
  for (const [, rawMeta] of ordered) {
    const meta = asObject(rawMeta, OFFLINE_KEY);
    const affected = resolveOwnerServerIndexKey(meta.serverId, scope) === scope.serverIndexKey;
    const next = affected ? {
      ...meta,
      serverId: scope.serverIndexKey,
      id: canonicalId(meta.id),
      trackIds: Array.isArray(meta.trackIds) ? meta.trackIds.map(canonicalId) : meta.trackIds,
      coverArt: canonicalArtwork(meta.coverArt),
    } : meta;
    if (typeof next.serverId !== 'string' || typeof next.id !== 'string') {
      throw new Error(`Malformed persisted state in ${OFFLINE_KEY}`);
    }
    const key = `${next.serverId}:${next.id}`;
    const existing = albums[key];
    if (!existing) {
      albums[key] = next;
      continue;
    }
    const trackIds = [
      ...(Array.isArray(existing.trackIds) ? existing.trackIds : []),
      ...(Array.isArray(next.trackIds) ? next.trackIds : []),
    ].filter((value): value is string => typeof value === 'string');
    albums[key] = { ...mergeCompleteObjects(existing, next), trackIds: [...new Set(trackIds)] };
  }
  state.albums = albums;
  writeJson(storage, OFFLINE_KEY, { ...root, state });
}

function rewriteDeviceSyncState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const raw = readJson(storage, DEVICE_SYNC_KEY);
  if (raw === null) return;
  const root = asObject(raw, DEVICE_SYNC_KEY);
  const state = asObject(root.state, DEVICE_SYNC_KEY);
  if (Array.isArray(state.sources)) {
    const sources = new Map<string, unknown>();
    for (const rawSource of state.sources) {
      if (!isObject(rawSource)) continue;
      const source = resolveOwnerServerIndexKey(rawSource.serverIndexKey, scope) === scope.serverIndexKey
        ? {
            ...rawSource,
            serverIndexKey: scope.serverIndexKey,
            id: canonicalId(rawSource.id),
          }
        : rawSource;
      if (typeof source.serverIndexKey !== 'string' || typeof source.type !== 'string' || typeof source.id !== 'string') {
        continue;
      }
      const key = JSON.stringify([source.serverIndexKey, source.type, source.id]);
      const existing = sources.get(key);
      sources.set(key, isObject(existing) ? mergeCompleteObjects(existing, source) : source);
    }
    state.sources = [...sources.values()];
  }
  if (Array.isArray(state.pendingDeletion)) {
    state.pendingDeletion = [...new Set(state.pendingDeletion.map(value => {
      if (typeof value !== 'string') return value;
      try {
        const key = JSON.parse(value) as unknown;
        if (!Array.isArray(key) || key.length !== 3 || key.some(part => typeof part !== 'string')) {
          return value;
        }
        const owner = resolveOwnerServerIndexKey(key[0], scope);
        return owner === scope.serverIndexKey
          ? JSON.stringify([scope.serverIndexKey, key[1], canonicalNavidromeId(key[2])])
          : value;
      } catch {
        return value;
      }
    }))];
  }
  writeJson(storage, DEVICE_SYNC_KEY, { ...root, state });
}

function rewritePlaylists(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const raw = readJson(storage, PLAYLIST_KEY);
  if (raw === null) return;
  const root = asObject(raw, PLAYLIST_KEY);
  const state = asObject(root.state, PLAYLIST_KEY);
  if (Array.isArray(state.playlists)) {
    const playlists = new Map<string, unknown>();
    for (const rawPlaylist of state.playlists) {
      if (!isObject(rawPlaylist)) continue;
      const playlist = resolveOwnerServerIndexKey(rawPlaylist.serverId, scope) === scope.serverIndexKey
        ? {
            ...rawPlaylist,
            id: canonicalId(rawPlaylist.id),
            coverArt: canonicalArtwork(rawPlaylist.coverArt),
          }
        : rawPlaylist;
      const key = `${String(playlist.serverId ?? '')}:${String(playlist.id ?? '')}`;
      const existing = playlists.get(key);
      playlists.set(key, isObject(existing) ? mergeCompleteObjects(existing, playlist) : playlist);
    }
    state.playlists = [...playlists.values()];
  }
  if (Array.isArray(state.recentIds)) {
    state.recentIds = [...new Set(state.recentIds.map(value => (
      typeof value === 'string' ? rewriteOwnedEntityKey(value, scope) : value
    )))];
  }
  if (isObject(state.lastModified)) {
    const lastModified: JsonObject = {};
    for (const [key, value] of Object.entries(state.lastModified)) {
      const rewritten = rewriteOwnedEntityKey(key, scope);
      const existing = lastModified[rewritten];
      lastModified[rewritten] = typeof existing === 'number' && typeof value === 'number'
        ? Math.max(existing, value)
        : value;
    }
    state.lastModified = lastModified;
  }
  writeJson(storage, PLAYLIST_KEY, { ...root, state });
}

function rewritePlaylistFolders(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const raw = readJson(storage, PLAYLIST_FOLDERS_KEY);
  if (raw === null) return;
  const root = asObject(raw, PLAYLIST_FOLDERS_KEY);
  const state = asObject(root.state, PLAYLIST_FOLDERS_KEY);
  if (!isObject(state.byServer)) {
    writeJson(storage, PLAYLIST_FOLDERS_KEY, { ...root, state });
    return;
  }
  const byServer = { ...state.byServer };
  for (const [owner, rawBucket] of Object.entries(byServer)) {
    if (resolveOwnerServerIndexKey(owner, scope) !== scope.serverIndexKey) continue;
    const bucket = asObject(rawBucket, PLAYLIST_FOLDERS_KEY);
    if (!isObject(bucket.assignments)) continue;
    const assignments: JsonObject = {};
    for (const [playlistId, folderId] of Object.entries(bucket.assignments)) {
      const rewritten = canonicalNavidromeId(playlistId);
      if (rewritten in assignments && assignments[rewritten] !== folderId) {
        throw new Error(`Playlist folder collision at ${owner}:${rewritten}`);
      }
      assignments[rewritten] = folderId;
    }
    byServer[owner] = { ...bucket, assignments };
  }
  state.byServer = byServer;
  writeJson(storage, PLAYLIST_FOLDERS_KEY, { ...root, state });
}

function rewriteRadioState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  for (const key of RADIO_KEYS) {
    const raw = readJson(storage, key);
    if (raw === null) continue;
    if (!Array.isArray(raw)) throw new Error(`Malformed persisted state in ${key}`);
    writeJson(storage, key, [...new Set(raw.map(value => (
      typeof value === 'string' ? rewriteOwnedEntityKey(value, scope) : value
    )))]);
  }
}

function rewriteNewReleasesState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(NEW_RELEASES_PREFIX)));
  for (const oldKey of keys) {
    let fingerprint: unknown;
    try {
      fingerprint = JSON.parse(oldKey.slice(NEW_RELEASES_PREFIX.length)) as unknown;
    } catch {
      continue;
    }
    if (!Array.isArray(fingerprint)) continue;
    let affected = false;
    const nextFingerprint = fingerprint.map(entry => {
      if (!Array.isArray(entry) || entry.length !== 2 || !scope.profileIds.includes(String(entry[0])) || !Array.isArray(entry[1])) {
        return entry;
      }
      affected = true;
      return [entry[0], entry[1].map(canonicalId)];
    });
    if (!affected) continue;
    const ids = readJson(storage, oldKey);
    if (!Array.isArray(ids)) throw new Error(`Malformed persisted state in ${oldKey}`);
    const newKey = `${NEW_RELEASES_PREFIX}${JSON.stringify(nextFingerprint)}`;
    const existing = oldKey === newKey ? [] : readJson(storage, newKey);
    if (existing !== null && !Array.isArray(existing)) throw new Error(`Malformed persisted state in ${newKey}`);
    writeJson(storage, newKey, [...new Set([
      ...(Array.isArray(existing) ? existing : []),
      ...ids.map(canonicalId),
    ])]);
    if (newKey !== oldKey) storage.removeItem(oldKey);
  }
}

function invalidateDerivedState(storage: NavidromeCanonicalFrontendStorage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key));
  for (const key of keys) {
    if (INVALIDATED_PREFIXES.some(prefix => key.startsWith(prefix))) storage.removeItem(key);
  }
}

function assertCanonical(value: unknown, label: string): void {
  if (typeof value === 'string' && canonicalNavidromeId(value) !== value) {
    throw new Error(`Legacy ${label} remains in frontend persistence`);
  }
}

function assertCanonicalArtwork(value: unknown, label: string): void {
  if (typeof value === 'string' && canonicalNavidromeArtworkId(value) !== value) {
    throw new Error(`Legacy ${label} remains in frontend persistence`);
  }
}

function assertCanonicalTrack(value: unknown, label: string): void {
  const track = asObject(value, label);
  assertCanonical(track.id, `${label} track ID`);
  assertCanonical(track.albumId, `${label} album ID`);
  assertCanonical(track.artistId, `${label} artist ID`);
  assertCanonicalArtwork(track.coverArt, `${label} artwork ID`);
  for (const field of ['artists', 'albumArtists'] as const) {
    if (!Array.isArray(track[field])) continue;
    track[field].forEach(raw => isObject(raw) && assertCanonical(raw.id, `${label} artist reference ID`));
  }
  if (Array.isArray(track.contributors)) {
    track.contributors.forEach(raw => {
      if (isObject(raw) && isObject(raw.artist)) {
        assertCanonical(raw.artist.id, `${label} contributor artist ID`);
      }
    });
  }
}

function assertCanonicalIdList(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`Malformed persisted state in ${label}`);
  value.forEach(id => assertCanonical(id, label));
}

export function verifyNavidromeCanonicalFrontendState(
  storage: NavidromeCanonicalFrontendStorage,
  scope: NavidromeCanonicalFrontendScope,
): void {
  const owners = ownerSet(scope);
  const auth = readJson(storage, AUTH_KEY);
  if (auth !== null) {
    const state = asObject(asObject(auth, AUTH_KEY).state, AUTH_KEY);
    if (isObject(state.musicFoldersByServer)) {
      for (const owner of owners) {
        if (!(owner in state.musicFoldersByServer)) continue;
        const folders = state.musicFoldersByServer[owner];
        if (!Array.isArray(folders)) throw new Error(`Malformed persisted state in ${AUTH_KEY}`);
        folders.forEach(folder => isObject(folder) && assertCanonical(folder.id, 'music-folder ID'));
      }
    }
    for (const field of ['libraryBrowseSelectionByServer', 'musicLibrarySelectionByServer'] as const) {
      if (!isObject(state[field])) continue;
      for (const owner of owners) {
        if (owner in state[field]) assertCanonicalIdList(state[field][owner], `${AUTH_KEY}.${field}`);
      }
    }
    if (isObject(state.musicLibraryFilterByServer)) {
      for (const owner of owners) {
        const value = state.musicLibraryFilterByServer[owner];
        if (value !== 'all') assertCanonical(value, 'music-library filter ID');
      }
    }
    if (ownerMatches(state.activeServerId, new Set(scope.profileIds)) && Array.isArray(state.musicFolders)) {
      state.musicFolders.forEach(folder => isObject(folder) && assertCanonical(folder.id, 'active music-folder ID'));
    }
    if (isObject(state.skipStarManualSkipCountsByKey)) {
      for (const key of Object.keys(state.skipStarManualSkipCountsByKey)) {
        const separator = key.indexOf('\u001f');
        if (separator <= 0 || separator === key.length - 1) {
          throw new Error(`Malformed persisted state in ${AUTH_KEY}`);
        }
        if (resolveOwnerServerIndexKey(key.slice(0, separator), scope) === scope.serverIndexKey) {
          assertCanonical(key.slice(separator + 1), 'skip-star track ID');
        }
      }
    }
  }

  const player = readJson(storage, PLAYER_KEY);
  if (player !== null) {
    const state = asObject(asObject(player, PLAYER_KEY).state, PLAYER_KEY);
    if (isObject(state.currentTrack)
      && (ownerMatches(state.currentTrack.serverId, owners) || ownerMatches(state.queueServerId, owners))) {
      assertCanonicalTrack(state.currentTrack, PLAYER_KEY);
    }
    if (Array.isArray(state.queueItems)) {
      for (const rawItem of state.queueItems) {
        if (isObject(rawItem) && ownerMatches(rawItem.serverId, owners)) assertCanonical(rawItem.trackId, 'queue track ID');
      }
    }
    if (ownerMatches(state.queueServerId, owners)) {
      if (Array.isArray(state.queueRefs)) state.queueRefs.forEach(id => assertCanonical(id, 'queue reference ID'));
      if (Array.isArray(state.queue)) state.queue.forEach(track => assertCanonicalTrack(track, PLAYER_KEY));
    }
  }

  const shuffle = readJson(storage, SHUFFLE_KEY);
  if (shuffle !== null) {
    const snapshot = asObject(shuffle, SHUFFLE_KEY);
    if (Array.isArray(snapshot.originalOrder)) {
      for (const value of snapshot.originalOrder) {
        if (typeof value !== 'string') continue;
        try {
          const parsed = JSON.parse(value) as unknown;
          if (Array.isArray(parsed) && parsed.length === 2 && ownerMatches(parsed[0], owners)) {
            assertCanonical(parsed[1], 'shuffle track ID');
          }
        } catch {
          const queueOwner = player === null
            ? null
            : asObject(asObject(player, PLAYER_KEY).state, PLAYER_KEY).queueServerId;
          if (ownerMatches(queueOwner, owners)) assertCanonical(value, 'shuffle track ID');
        }
      }
    }
  }

  const local = readJson(storage, LOCAL_PLAYBACK_KEY);
  if (local !== null) {
    const entries = asObject(asObject(asObject(local, LOCAL_PLAYBACK_KEY).state, LOCAL_PLAYBACK_KEY).entries, LOCAL_PLAYBACK_KEY);
    for (const [persistedKey, rawEntry] of Object.entries(entries)) {
      const entry = asObject(rawEntry, LOCAL_PLAYBACK_KEY);
      if (resolveOwnerServerIndexKey(entry.serverIndexKey, scope) !== scope.serverIndexKey) continue;
      assertCanonical(entry.trackId, 'local track ID');
      if (persistedKey !== `${scope.serverIndexKey}:${String(entry.trackId)}` || entry.serverIndexKey !== scope.serverIndexKey) {
        throw new Error(`Legacy local playback key remains in frontend persistence`);
      }
      if (isObject(entry.pinSource)) {
        assertCanonical(entry.pinSource.sourceId, 'pin source ID');
      }
      if (Array.isArray(entry.pinSources)) {
        entry.pinSources.forEach(source => {
          if (isObject(source)) assertCanonical(source.sourceId, 'pin source ID');
        });
      }
    }
  }

  const offline = readJson(storage, OFFLINE_KEY);
  if (offline !== null) {
    const state = asObject(asObject(offline, OFFLINE_KEY).state, OFFLINE_KEY);
    if (isObject(state.tracks)) {
      for (const [persistedKey, rawTrack] of Object.entries(state.tracks)) {
        const track = asObject(rawTrack, OFFLINE_KEY);
        if (resolveOwnerServerIndexKey(track.serverId, scope) !== scope.serverIndexKey) continue;
        assertCanonical(track.id, 'legacy offline track ID');
        assertCanonical(track.albumId, 'legacy offline album ID');
        assertCanonical(track.artistId, 'legacy offline artist ID');
        assertCanonicalArtwork(track.coverArt, 'legacy offline artwork ID');
        if (persistedKey !== `${scope.serverIndexKey}:${String(track.id)}` || track.serverId !== scope.serverIndexKey) {
          throw new Error(`Legacy offline track key remains in frontend persistence`);
        }
      }
    }
    if (isObject(state.albums)) {
      for (const [persistedKey, rawMeta] of Object.entries(state.albums)) {
        const meta = asObject(rawMeta, OFFLINE_KEY);
        if (resolveOwnerServerIndexKey(meta.serverId, scope) !== scope.serverIndexKey) continue;
        assertCanonical(meta.id, `${offlineKind(meta.type)} ID`);
        if (Array.isArray(meta.trackIds)) meta.trackIds.forEach(id => assertCanonical(id, 'offline track ID'));
        assertCanonicalArtwork(meta.coverArt, 'offline artwork ID');
        if (persistedKey !== `${scope.serverIndexKey}:${String(meta.id)}` || meta.serverId !== scope.serverIndexKey) {
          throw new Error(`Legacy offline source key remains in frontend persistence`);
        }
      }
    } else if (state.albums !== undefined) {
      throw new Error(`Malformed persisted state in ${OFFLINE_KEY}`);
    }
  }

  const device = readJson(storage, DEVICE_SYNC_KEY);
  if (device !== null) {
    const state = asObject(asObject(device, DEVICE_SYNC_KEY).state, DEVICE_SYNC_KEY);
    if (Array.isArray(state.sources)) {
      for (const rawSource of state.sources) {
        if (isObject(rawSource)
          && resolveOwnerServerIndexKey(rawSource.serverIndexKey, scope) === scope.serverIndexKey) {
          if (rawSource.serverIndexKey !== scope.serverIndexKey) {
            throw new Error(`Legacy Device Sync owner remains in frontend persistence`);
          }
          assertCanonical(rawSource.id, 'Device Sync source ID');
        }
      }
    }
  }

  const playlists = readJson(storage, PLAYLIST_KEY);
  if (playlists !== null) {
    const state = asObject(asObject(playlists, PLAYLIST_KEY).state, PLAYLIST_KEY);
    if (Array.isArray(state.playlists)) {
      for (const rawPlaylist of state.playlists) {
        if (isObject(rawPlaylist)
          && resolveOwnerServerIndexKey(rawPlaylist.serverId, scope) === scope.serverIndexKey) {
          assertCanonical(rawPlaylist.id, 'playlist ID');
          assertCanonicalArtwork(rawPlaylist.coverArt, 'playlist artwork ID');
        }
      }
    }
    if (Array.isArray(state.recentIds)) {
      for (const value of state.recentIds) {
        if (typeof value !== 'string') continue;
        const parts = splitKnownOwnerKey(value, scope);
        if (parts && resolveOwnerServerIndexKey(parts[0], scope) === scope.serverIndexKey) {
          assertCanonical(parts[1], 'recent playlist ID');
        }
      }
    }
    if (isObject(state.lastModified)) {
      for (const key of Object.keys(state.lastModified)) {
        const parts = splitKnownOwnerKey(key, scope);
        if (parts && resolveOwnerServerIndexKey(parts[0], scope) === scope.serverIndexKey) {
          assertCanonical(parts[1], 'playlist last-modified ID');
        }
      }
    }
  }

  const playlistFolders = readJson(storage, PLAYLIST_FOLDERS_KEY);
  if (playlistFolders !== null) {
    const state = asObject(asObject(playlistFolders, PLAYLIST_FOLDERS_KEY).state, PLAYLIST_FOLDERS_KEY);
    if (isObject(state.byServer)) {
      for (const [owner, rawBucket] of Object.entries(state.byServer)) {
        if (resolveOwnerServerIndexKey(owner, scope) !== scope.serverIndexKey) continue;
        const bucket = asObject(rawBucket, PLAYLIST_FOLDERS_KEY);
        if (isObject(bucket.assignments)) {
          Object.keys(bucket.assignments).forEach(id => assertCanonical(id, 'playlist folder assignment ID'));
        }
      }
    }
  }

  for (const key of RADIO_KEYS) {
    const raw = readJson(storage, key);
    if (raw === null) continue;
    if (!Array.isArray(raw)) throw new Error(`Malformed persisted state in ${key}`);
    for (const value of raw) {
      if (typeof value !== 'string') continue;
      const parts = splitKnownOwnerKey(value, scope);
      if (parts && resolveOwnerServerIndexKey(parts[0], scope) === scope.serverIndexKey) {
        assertCanonical(parts[1], 'radio ID');
      }
    }
  }

  const releaseKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(NEW_RELEASES_PREFIX)));
  for (const key of releaseKeys) {
    let fingerprint: unknown;
    try {
      fingerprint = JSON.parse(key.slice(NEW_RELEASES_PREFIX.length)) as unknown;
    } catch (error) {
      const wrapped = new Error(`Malformed persisted state in ${key}`) as Error & { cause?: unknown };
      wrapped.cause = error;
      throw wrapped;
    }
    if (!Array.isArray(fingerprint)) throw new Error(`Malformed persisted state in ${key}`);
    const affected = fingerprint.some(entry => {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      if (!scope.profileIds.includes(String(entry[0]))) return false;
      assertCanonicalIdList(entry[1], 'new-releases library ID');
      return true;
    });
    if (affected) assertCanonicalIdList(readJson(storage, key), 'new-releases album ID');
  }

  if (storage.getItem(HOT_CACHE_KEY) !== null) {
    throw new Error(`Legacy ${HOT_CACHE_KEY} source remains in frontend persistence`);
  }
  const persistedKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key));
  if (persistedKeys.some(key => INVALIDATED_PREFIXES.some(prefix => key.startsWith(prefix)))) {
    throw new Error('Legacy derived identity cache remains in frontend persistence');
  }
}

/** Rewrite all declared identity-bearing frontend persistence before Zustand imports hydrate it. */
export function rewriteNavidromeCanonicalFrontendState(
  scope: NavidromeCanonicalFrontendScope,
  storage: NavidromeCanonicalFrontendStorage = localStorage,
): void {
  rewriteAuthState(storage, scope);
  const queueOwner = rewritePlayerState(storage, scope);
  rewriteShuffleState(storage, scope, queueOwner);
  rewriteLocalPlaybackState(storage, scope);
  rewriteOfflineState(storage, scope);
  mergeLegacyLocalPlaybackSources(storage, scope);
  rewriteDeviceSyncState(storage, scope);
  rewritePlaylists(storage, scope);
  rewritePlaylistFolders(storage, scope);
  rewriteRadioState(storage, scope);
  rewriteNewReleasesState(storage, scope);
  invalidateDerivedState(storage);
  storage.removeItem(HOT_CACHE_KEY);
  verifyNavidromeCanonicalFrontendState(storage, scope);
  writeMarker(storage, LOCAL_PLAYBACK_MIGRATED_KEY, '1');
}
