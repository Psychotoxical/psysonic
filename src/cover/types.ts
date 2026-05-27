/** Subsonic / Navidrome id passed to `getCoverArt.view` (`al-*`, `ar-*`, …). */
export type CoverArtId = string;

export type CoverCacheKind = 'album' | 'artist';

/** Fixed storage / server-request tiers */
export const COVER_ART_TIERS = [64, 128, 256, 512, 800, 2000] as const;

/** Max tier for dense grids — decode perf */
export const COVER_ART_DENSE_MAX_TIER = 512 as const;

export type CoverArtTier = (typeof COVER_ART_TIERS)[number];

export type CoverServerScope =
  | { kind: 'active' }
  | { kind: 'playback' }
  | { kind: 'server'; serverId: string; url: string; username: string; password: string };

/** Stable singleton — never inline `{ kind: 'active' }` in hook deps or default params. */
export const COVER_SCOPE_ACTIVE: CoverServerScope = { kind: 'active' };

export function coverScopeKey(scope: CoverServerScope): string {
  if (scope.kind === 'active') return 'active';
  if (scope.kind === 'playback') return 'playback';
  return `server:${scope.serverId}`;
}

export type CoverSurfaceKind = 'dense' | 'sparse';

export type CoverPrefetchPriority = 'high' | 'middle' | 'low';

/** Disk cache is keyed by `cacheKind` + `cacheEntityId`; HTTP uses `fetchCoverArtId`. */
export type CoverArtRef = {
  cacheKind: CoverCacheKind;
  /** Disk segment — usually `al-*` / `ar-*`; per-CD `mf-*` only when album has distinct disc art. */
  cacheEntityId: string;
  /** Navidrome `getCoverArt` id — usually matches `cacheEntityId`; may differ only transiently. */
  fetchCoverArtId: CoverArtId;
  serverScope: CoverServerScope;
};

export type CoverArtHandle = {
  src: string;
  storageKey: string;
  /** Alias for {@link storageKey} — migration shim for legacy `cacheKey` consumers */
  cacheKey: string;
  tier: CoverArtTier;
  provisional: boolean;
  /** Retry disk ensure after a broken/stale `src` (e.g. post cache clear). */
  onImgError?: () => void;
};

export type CoverFullResIntent = { kind: 'tier2000' };

export type CoverRevalidateReason = 'library_delta' | 'scheduled' | 'upload' | 'manual';
