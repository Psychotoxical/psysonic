/** Subsonic / Navidrome cover art ID passed to getCoverArt.view */
export type CoverArtId = string;

/** Fixed storage / server-request tiers */
export const COVER_ART_TIERS = [64, 128, 256, 512, 800, 2000] as const;

/** Max tier for dense grids — decode perf */
export const COVER_ART_DENSE_MAX_TIER = 512 as const;

export type CoverArtTier = (typeof COVER_ART_TIERS)[number];

export type CoverServerScope =
  | { kind: 'active' }
  | { kind: 'playback' }
  | { kind: 'server'; serverId: string; url: string; username: string; password: string };

export type CoverSurfaceKind = 'dense' | 'sparse';

export type CoverPrefetchPriority = 'high' | 'middle' | 'low';

export type CoverArtRef = {
  coverArtId: CoverArtId;
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
