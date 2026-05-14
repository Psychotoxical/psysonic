export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Always-MB variant for size totals that are conventionally shown in MB
 * regardless of magnitude (album / playlist / device-sync totals). */
export function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Align hot-cache size slider (step 32 MB) to valid values. */
export function snapHotCacheMb(v: number): number {
  const x = Math.min(20000, Math.max(32, Math.round(v)));
  return Math.round((x - 32) / 32) * 32 + 32;
}
