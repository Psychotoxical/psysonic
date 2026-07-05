const IDLE_TIMEOUT_MS = 1200;

/** Run work after first paint / when the main thread is idle (album browse background fetches). */
export function scheduleAlbumBrowseBackgroundWork(run: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => run(), { timeout: IDLE_TIMEOUT_MS });
  } else {
    window.setTimeout(run, 0);
  }
}
