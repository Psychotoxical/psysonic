import {
  libraryCoverBackfillConfigure,
  libraryCoverBackfillSetUiPriority,
} from '@/lib/api/coverCache';
import { coverEnsureCancelPending } from './ensureQueue';
import { coverPeekCancelPending } from './peekQueue';
import { coverPrefetchClearRegistry } from './prefetchRegistry';

function cancelVisibleCoverWork(): void {
  coverEnsureCancelPending();
  coverPeekCancelPending();
  coverPrefetchClearRegistry();
}

let navigationHoldDepth = 0;
/** Album grid SQL page fetch — pause middle/low cover work until rows settle. */
let gridPaginationHoldDepth = 0;
let serverSwitchHold = false;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let serverSwitchEndTimer: ReturnType<typeof setTimeout> | null = null;

const NAVIGATION_QUIET_MS = 400;
const SERVER_SWITCH_QUIET_MS = 700;

function syncBackfillUiPriority(): void {
  const hold = navigationHoldDepth > 0 || serverSwitchHold;
  void libraryCoverBackfillSetUiPriority(hold);
}

function pauseLibraryBackfillSession(): void {
  void libraryCoverBackfillConfigure({
    enabled: false,
    serverIndexKey: '',
    libraryServerId: '',
    restBaseUrl: '',
    username: '',
    password: '',
  });
}

/** Route change — drop queued peek/ensure/prefetch so the new page is not behind the old one. */
export function coverTrafficBeginNavigation(): void {
  navigationHoldDepth += 1;
  cancelVisibleCoverWork();
  syncBackfillUiPriority();
}

export function coverTrafficEndNavigation(): void {
  navigationHoldDepth = Math.max(0, navigationHoldDepth - 1);
  scheduleNavigationResume();
}

/** Local album browse page fetch — avoid middle-priority cover storms during SQL pagination. */
export function coverTrafficBeginGridPagination(): void {
  gridPaginationHoldDepth += 1;
}

export function coverTrafficEndGridPagination(): void {
  gridPaginationHoldDepth = Math.max(0, gridPaginationHoldDepth - 1);
}

/** Active server change — stop all cover IPC so ping + menu stay responsive. */
export function coverTrafficBeginServerSwitch(): void {
  serverSwitchHold = true;
  if (serverSwitchEndTimer) {
    clearTimeout(serverSwitchEndTimer);
    serverSwitchEndTimer = null;
  }
  cancelVisibleCoverWork();
  pauseLibraryBackfillSession();
  syncBackfillUiPriority();
}

export function coverTrafficEndServerSwitch(): void {
  if (serverSwitchEndTimer) clearTimeout(serverSwitchEndTimer);
  serverSwitchEndTimer = setTimeout(() => {
    serverSwitchHold = false;
    serverSwitchEndTimer = null;
    syncBackfillUiPriority();
  }, SERVER_SWITCH_QUIET_MS);
}

export function coverTrafficBackgroundPaused(): boolean {
  return navigationHoldDepth > 0 || gridPaginationHoldDepth > 0 || serverSwitchHold;
}

/** @internal Diagnostics / tests — album grid SQL hold depth. */
export function coverTrafficGridPaginationDepth(): number {
  return gridPaginationHoldDepth;
}

/** Hard stop for ensure/peek pumps (includes visible `high` grid jobs). */
export function coverTrafficServerSwitchPaused(): boolean {
  return serverSwitchHold;
}

function scheduleNavigationResume(): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    syncBackfillUiPriority();
  }, NAVIGATION_QUIET_MS);
}

/** Test-only — reset module hold state between cases. */
export function __test_resetCoverTraffic(): void {
  navigationHoldDepth = 0;
  gridPaginationHoldDepth = 0;
  serverSwitchHold = false;
  if (resumeTimer) clearTimeout(resumeTimer);
  if (serverSwitchEndTimer) clearTimeout(serverSwitchEndTimer);
  resumeTimer = null;
  serverSwitchEndTimer = null;
}
