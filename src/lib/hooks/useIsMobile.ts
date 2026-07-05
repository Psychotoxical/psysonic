import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 800;
const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

let mql: MediaQueryList | null = null;

function getMql(): MediaQueryList {
  if (!mql) mql = window.matchMedia(query);
  return mql;
}

function subscribe(cb: () => void): () => void {
  const m = getMql();
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

function getSnapshot(): boolean {
  return getMql().matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns `true` when the viewport width is below 800px.
 * Updates in real-time on resize via `matchMedia`.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
