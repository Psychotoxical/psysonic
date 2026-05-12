/**
 * Short cooldown guard for the play/pause toggle so a rapid double-click
 * doesn't send two state transitions to the Rust backend before the first
 * one has finished. Held for 300 ms by default — long enough to absorb a
 * double-click + the engine round-trip, short enough that intentional
 * fast toggles still feel responsive.
 *
 * Usage:
 *
 *   if (!tryAcquireTogglePlayLock()) return;
 *   // ... perform toggle ...
 *
 * The lock auto-releases on a timer; no manual release call needed.
 */

let togglePlayLock = false;
const DEFAULT_LOCK_MS = 300;

export function tryAcquireTogglePlayLock(durationMs: number = DEFAULT_LOCK_MS): boolean {
  if (togglePlayLock) return false;
  togglePlayLock = true;
  setTimeout(() => { togglePlayLock = false; }, durationMs);
  return true;
}

/** Test-only: force-release the lock so each spec starts fresh. */
export function _resetTogglePlayLockForTest(): void {
  togglePlayLock = false;
}
