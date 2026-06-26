/**
 * Per-album memory of the external backdrop images (fanart/banner) that have
 * resolved to disk, keyed by album id. Both the prefetch warmer
 * (`warmHeroArtistBackdrops`) and the live hero hook (`useHeroBackdrop`) record
 * into it; on **re-entry** to a slide the hook reads it synchronously so the
 * higher-priority source paints at once instead of falling back to Navidrome
 * again while its async ensure re-resolves (cucadmuh's `{albumId → upgradedUrl}`).
 *
 * Bounded FIFO — the hero only cycles a handful of albums, but feed refreshes
 * rotate the set over a session.
 */

type ExternalSurface = 'banner' | 'fanart';
type Entry = Partial<Record<ExternalSurface, string>>;

const MAX_ENTRIES = 48;
const mem = new Map<string, Entry>();

export function recordHeroBackdropUpgrade(
  albumId: string | undefined,
  surface: ExternalSurface,
  url: string,
): void {
  if (!albumId || !url) return;
  const existing = mem.get(albumId);
  if (existing?.[surface] === url) return;
  const entry: Entry = { ...(existing ?? {}), [surface]: url };
  // Refresh insertion order so the most recently touched album evicts last.
  mem.delete(albumId);
  mem.set(albumId, entry);
  while (mem.size > MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

export function getHeroBackdropUpgrade(albumId: string | undefined): Entry | undefined {
  return albumId ? mem.get(albumId) : undefined;
}

/** @internal Vitest-only. */
export function __test_resetHeroBackdropMemory(): void {
  mem.clear();
}
