export type BrowsableLocalPlaybackTier = 'library' | 'favorite-auto' | 'ephemeral';

/** Tiers with on-disk bytes eligible for offline local browse. */
export function isBrowsableLocalPlaybackTier(tier: string): tier is BrowsableLocalPlaybackTier {
  return tier === 'library' || tier === 'favorite-auto' || tier === 'ephemeral';
}

export function hasBrowsableLocalPlaybackBytes(entry: {
  tier: string;
  localPath?: string | null;
}): boolean {
  return isBrowsableLocalPlaybackTier(entry.tier) && !!entry.localPath;
}
