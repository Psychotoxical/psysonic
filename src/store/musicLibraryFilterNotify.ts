type FilterVersionBump = () => void;

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
