export interface HotCacheEntry {
  localPath: string;
  sizeBytes: number;
  cachedAt: number;
  lastPlayedAt?: number;
}
