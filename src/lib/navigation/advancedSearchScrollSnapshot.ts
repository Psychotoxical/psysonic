import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import {
  useAdvancedSearchSessionStore,
  type AdvancedSearchSessionStash,
} from '@/store/advancedSearchSessionStore';

export type AdvancedSearchLeaveSnapshot = {
  scrollTop: number;
  albumRowScrollLeft: number;
  artistRowScrollLeft: number;
};

const STORAGE_KEY = 'psysonic:advanced-search-leave-v1';

type LeaveScrollProvider = () => AdvancedSearchLeaveSnapshot;
type SessionProvider = () => AdvancedSearchSessionStash;

let leaveScrollProvider: LeaveScrollProvider | null = null;
let sessionProvider: SessionProvider | null = null;
let leavingAdvancedSearchForDetail = false;

export function registerAdvancedSearchLeaveScrollProvider(
  provider: LeaveScrollProvider,
): () => void {
  leaveScrollProvider = provider;
  return () => {
    if (leaveScrollProvider === provider) leaveScrollProvider = null;
  };
}

export function registerAdvancedSearchSessionProvider(
  provider: SessionProvider,
): () => void {
  sessionProvider = provider;
  return () => {
    if (sessionProvider === provider) sessionProvider = null;
  };
}

export function markAdvancedSearchLeavingForDetail(): void {
  leavingAdvancedSearchForDetail = true;
}

export function consumeAdvancedSearchLeavingForDetail(): boolean {
  const value = leavingAdvancedSearchForDetail;
  leavingAdvancedSearchForDetail = false;
  return value;
}

function readAlbumRowScrollLeftFromDom(): number {
  const albumGrid = document.querySelector<HTMLElement>('[data-advanced-search-album-row] .album-grid');
  return albumGrid?.scrollLeft ?? 0;
}

function readArtistRowScrollLeftFromDom(): number {
  const artistGrid = document.querySelector<HTMLElement>('[data-advanced-search-artist-row] .album-grid');
  return artistGrid?.scrollLeft ?? 0;
}

function readMainScrollTopFromDom(): number {
  return document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID)?.scrollTop ?? 0;
}

function readMainScrollTopForLeave(providerSnap?: AdvancedSearchLeaveSnapshot): number {
  const fromDom = readMainScrollTopFromDom();
  const fromProvider = providerSnap?.scrollTop ?? 0;
  // After route commit the DOM viewport may already be the destination page (scrollTop 0).
  return Math.max(fromDom, fromProvider);
}

export function readAdvancedSearchLeaveSnapshot(): AdvancedSearchLeaveSnapshot {
  const providerSnap = leaveScrollProvider?.();
  return {
    scrollTop: readMainScrollTopForLeave(providerSnap),
    albumRowScrollLeft: Math.max(
      readAlbumRowScrollLeftFromDom(),
      providerSnap?.albumRowScrollLeft ?? 0,
    ),
    artistRowScrollLeft: Math.max(
      readArtistRowScrollLeftFromDom(),
      providerSnap?.artistRowScrollLeft ?? 0,
    ),
  };
}

function persistLeaveSnapshot(snapshot: AdvancedSearchLeaveSnapshot): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode */
  }
}

export function peekPersistedAdvancedSearchLeaveSnapshot(): AdvancedSearchLeaveSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AdvancedSearchLeaveSnapshot>;
    const scrollTop = typeof parsed.scrollTop === 'number' ? Math.max(0, parsed.scrollTop) : 0;
    const albumRowScrollLeft = typeof parsed.albumRowScrollLeft === 'number'
      ? Math.max(0, parsed.albumRowScrollLeft)
      : 0;
    const artistRowScrollLeft = typeof parsed.artistRowScrollLeft === 'number'
      ? Math.max(0, parsed.artistRowScrollLeft)
      : 0;
    if (scrollTop <= 0 && albumRowScrollLeft <= 0 && artistRowScrollLeft <= 0) return null;
    return { scrollTop, albumRowScrollLeft, artistRowScrollLeft };
  } catch {
    return null;
  }
}

export function clearPersistedAdvancedSearchLeaveSnapshot(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function saveAdvancedSearchLeaveSnapshot(): AdvancedSearchLeaveSnapshot {
  const snapshot = readAdvancedSearchLeaveSnapshot();
  persistLeaveSnapshot(snapshot);
  const store = useAdvancedSearchSessionStore.getState();
  store.setLeaveScrollSnapshot(snapshot);
  const session = sessionProvider?.();
  if (session) {
    store.stashReturnSession({
      ...session,
      scrollTop: snapshot.scrollTop,
      albumRowScrollLeft: snapshot.albumRowScrollLeft,
      artistRowScrollLeft: snapshot.artistRowScrollLeft,
    });
  }
  markAdvancedSearchLeavingForDetail();
  return snapshot;
}

export function clearAdvancedSearchLeaveSnapshots(): void {
  clearPersistedAdvancedSearchLeaveSnapshot();
  useAdvancedSearchSessionStore.getState().clearLeaveScrollSnapshot();
}

/** Merge zustand leave snapshot, sessionStorage, and session stash scroll fields. */
export function resolveAdvancedSearchLeaveSnapshot(
  stash: AdvancedSearchSessionStash | null,
): AdvancedSearchLeaveSnapshot | null {
  const leave = useAdvancedSearchSessionStore.getState().peekLeaveScrollSnapshot();
  const persisted = peekPersistedAdvancedSearchLeaveSnapshot();
  const scrollTop = Math.max(
    leave?.scrollTop ?? 0,
    persisted?.scrollTop ?? 0,
    stash?.scrollTop ?? 0,
  );
  const albumRowScrollLeft = Math.max(
    leave?.albumRowScrollLeft ?? 0,
    persisted?.albumRowScrollLeft ?? 0,
    stash?.albumRowScrollLeft ?? 0,
  );
  const artistRowScrollLeft = Math.max(
    leave?.artistRowScrollLeft ?? 0,
    persisted?.artistRowScrollLeft ?? 0,
    stash?.artistRowScrollLeft ?? 0,
  );
  if (scrollTop <= 0 && albumRowScrollLeft <= 0 && artistRowScrollLeft <= 0) return null;
  return { scrollTop, albumRowScrollLeft, artistRowScrollLeft };
}
