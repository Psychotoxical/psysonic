import {
  useAdvancedSearchSessionStore,
  type AdvancedSearchSessionStash,
} from '../../store/advancedSearchSessionStore';

const STORAGE_KEY = 'psysonic:advanced-search-album-row-scroll-v1';

type AlbumRowScrollProvider = () => number;

let albumRowScrollProvider: AlbumRowScrollProvider | null = null;
let leavingAdvancedSearchForAlbum = false;

export function registerAdvancedSearchAlbumRowScrollProvider(
  provider: AlbumRowScrollProvider,
): () => void {
  albumRowScrollProvider = provider;
  return () => {
    if (albumRowScrollProvider === provider) albumRowScrollProvider = null;
  };
}

export function markAdvancedSearchLeavingForAlbum(): void {
  leavingAdvancedSearchForAlbum = true;
}

export function consumeAdvancedSearchLeavingForAlbum(): boolean {
  const value = leavingAdvancedSearchForAlbum;
  leavingAdvancedSearchForAlbum = false;
  return value;
}

function readAlbumRowScrollLeftFromDom(): number {
  const albumGrid = document.querySelector<HTMLElement>('[data-advanced-search-album-row] .album-grid');
  return albumGrid?.scrollLeft ?? 0;
}

/** Read album-row horizontal scroll when leaving Advanced Search. */
export function readAdvancedSearchAlbumRowScrollLeft(): number {
  const domLeft = readAlbumRowScrollLeftFromDom();
  const providerLeft = albumRowScrollProvider?.() ?? 0;
  return Math.max(domLeft, providerLeft);
}

function persistAlbumRowScrollLeft(scrollLeft: number): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ albumRowScrollLeft: scrollLeft }));
  } catch {
    /* quota / private mode */
  }
}

export function persistAdvancedSearchAlbumRowScrollLeft(scrollLeft: number): void {
  persistAlbumRowScrollLeft(scrollLeft);
}

export function peekPersistedAdvancedSearchAlbumRowScrollLeft(): number | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { albumRowScrollLeft?: number };
    if (typeof parsed.albumRowScrollLeft !== 'number') return null;
    const scrollLeft = Math.max(0, parsed.albumRowScrollLeft);
    return scrollLeft > 0 ? scrollLeft : null;
  } catch {
    return null;
  }
}

export function clearPersistedAdvancedSearchAlbumRowScrollLeft(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function saveAdvancedSearchAlbumRowScrollOnLeave(): number {
  const scrollLeft = readAdvancedSearchAlbumRowScrollLeft();
  persistAlbumRowScrollLeft(scrollLeft);
  useAdvancedSearchSessionStore.getState().setLeaveAlbumRowScrollLeft(scrollLeft);
  markAdvancedSearchLeavingForAlbum();
  return scrollLeft;
}

export function clearAdvancedSearchAlbumRowScrollSnapshots(): void {
  clearPersistedAdvancedSearchAlbumRowScrollLeft();
  useAdvancedSearchSessionStore.getState().clearLeaveAlbumRowScrollLeft();
}

/** Merge zustand leave value, sessionStorage, and session stash. */
export function resolveAdvancedSearchAlbumRowScrollLeft(
  stash: AdvancedSearchSessionStash | null,
): number | null {
  const leave = useAdvancedSearchSessionStore.getState().peekLeaveAlbumRowScrollLeft() ?? 0;
  const persisted = peekPersistedAdvancedSearchAlbumRowScrollLeft() ?? 0;
  const fromStash = stash?.albumRowScrollLeft ?? 0;
  const scrollLeft = Math.max(leave, persisted, fromStash);
  return scrollLeft > 0 ? scrollLeft : null;
}
