type FilterVersionBump = () => void;

/**
 * Catalog-reload side effect (clear stale caches + warm the first chunk) after a
 * music-library filter/selection change. Registered from the app layer
 * (`app/musicLibraryCatalogReloadBridge`) so the store never imports the
 * `src/lib/library` browse helpers directly — that would put `src/lib` above the
 * store in the graph and create import cycles. No-op until registered (e.g. in unit tests).
 */
type CatalogReloadHandler = (serverId: string, indexEnabled: boolean, version: number) => void;

let catalogReloadHandler: CatalogReloadHandler | null = null;

export function registerMusicLibraryCatalogReloadHandler(handler: CatalogReloadHandler): void {
  catalogReloadHandler = handler;
}

export function runMusicLibraryCatalogReloadHandler(
  serverId: string,
  indexEnabled: boolean,
  version: number,
): void {
  catalogReloadHandler?.(serverId, indexEnabled, version);
}

let outerRaf: number | null = null;
let innerRaf: number | null = null;
let pendingBump: FilterVersionBump | null = null;

/**
 * Bump `musicLibraryFilterVersion` after the next paint so sidebar library
 * picker clicks update selection UI immediately without blocking on catalog refetch.
 */
export function scheduleMusicLibraryFilterVersionBump(bump: FilterVersionBump): void {
  pendingBump = bump;
  if (outerRaf != null) cancelAnimationFrame(outerRaf);
  if (innerRaf != null) cancelAnimationFrame(innerRaf);
  outerRaf = requestAnimationFrame(() => {
    outerRaf = null;
    innerRaf = requestAnimationFrame(() => {
      innerRaf = null;
      const run = pendingBump;
      pendingBump = null;
      run?.();
    });
  });
}

/** @internal Vitest — run any coalesced bump synchronously. */
export function flushMusicLibraryFilterVersionBumpForTests(): void {
  if (outerRaf != null) {
    cancelAnimationFrame(outerRaf);
    outerRaf = null;
  }
  if (innerRaf != null) {
    cancelAnimationFrame(innerRaf);
    innerRaf = null;
  }
  const run = pendingBump;
  pendingBump = null;
  run?.();
}
