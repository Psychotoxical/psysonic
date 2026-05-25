import { libraryCoverBackfillSetUiPriority } from '../api/coverCache';
import { coverEnsureOnNavigation } from './ensureQueue';

let navigationHold = false;
let holdToken = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

const NAVIGATION_QUIET_MS = 400;

/** Route change / scroll viewport swap — backfill yields, UI cover jobs stay. */
export function coverTrafficBeginNavigation(): void {
  holdToken += 1;
  navigationHold = true;
  coverEnsureOnNavigation();
  void libraryCoverBackfillSetUiPriority(true);
}

export function coverTrafficEndNavigation(): void {
  const token = holdToken;
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (token !== holdToken) return;
    navigationHold = false;
    void libraryCoverBackfillSetUiPriority(false);
    resumeTimer = null;
  }, NAVIGATION_QUIET_MS);
}

export function coverTrafficBackgroundPaused(): boolean {
  return navigationHold;
}
