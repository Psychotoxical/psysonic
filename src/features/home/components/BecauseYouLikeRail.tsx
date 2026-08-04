import { getArtistForServer, getArtistInfoForServer } from '@/lib/api/subsonicArtists';
import { resolveAlbum, resolveMediaServerId } from '@/features/offline';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { shuffleArray } from '@/lib/util/shuffleArray';
import React, { memo, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, ListPlus, Music } from 'lucide-react';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import { useLibraryCoverPrefetch } from '@/cover/useLibraryCoverPrefetch';
import { coverImgSrc } from '@/cover/imgSrc';
import { useCoverArt } from '@/cover/useCoverArt';
import { primeAlbumCoversForDisplay } from '@/cover/warmDiskPeek';
import {
  readBecauseYouLikeCache,
  writeBecauseYouLikeCache,
  type BecauseYouLikeAnchor,
} from '@/features/home/store/becauseYouLikeCache';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { playAlbum, playAlbumShuffled } from '@/features/playback/utils/playback/playAlbum';
import { useLongPressAction } from '@/lib/hooks/useLongPressAction';
import { LongPressWaveOverlay } from '@/ui/LongPressWaveOverlay';
import { formatHumanHoursMinutes } from '@/lib/format/formatHumanDuration';
import { AlbumRow, albumArtistDisplayName, useNavigateToAlbum } from '@/features/album';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import { appendServerQuery } from '@/lib/navigation/detailServerScope';
import {
  browseScopeLibraryIdsForServer,
  type LibraryBrowseScopePair,
} from '@/lib/library/libraryBrowseScope';

const ANCHOR_HISTORY_KEY_PREFIX = 'psysonic_because_anchor_history:';
const PICKS_HISTORY_KEY_PREFIX = 'psysonic_because_picks:';
/** Legacy single-anchor key from the round-robin era. The history-key prefix
 *  is `..._anchor_history:` so the colon-suffixed legacy prefix below cannot
 *  match the new keys — safe to strip on module load. */
const LEGACY_ANCHOR_KEY_PREFIX = 'psysonic_because_anchor:';

(() => {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_ANCHOR_KEY_PREFIX)) stale.push(k);
    }
    stale.forEach(k => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
  } catch { /* ignore */ }
})();
const TOP_ARTIST_POOL = 20;
const ANCHOR_MAX_TRIES = 4;
const ANCHOR_COOLDOWN = 5;
const SIMILAR_FETCH = 25;
const SIMILAR_PICK = 6;
const SHOW_COUNT = 3;
const PICKS_HISTORY_SIZE = 30;
/** `.because-card-cover-wrap` layout square (160×160). */
const BECAUSE_CARD_COVER_CSS_PX = 160;
const ROW_STAGGER_MS = 150;
// Wide cards and the compact AlbumRow have different geometry. Keep a dead band
// around their breakpoint so ResizeObserver cannot make them flip each other.
const NARROW_ENTER_WIDTH = 680;
const NARROW_EXIT_WIDTH = 712;

// ── Module-level reserve: next batch pre-fetched in background after each display ──
type BecauseReserve = {
  scopeKey: string;
  scopeVersion: number;
  // poolKey intentionally omitted — reserve is valid for any pool state on the
  // same scope. Pool (top-played artists) changes slowly; showing a slightly-off
  // anchor once before the next fill corrects it is far better than showing a
  // skeleton because the pool hadn't loaded yet.
  anchor: BecauseYouLikeAnchor;
  recs: SubsonicAlbum[];
  /** Rotation state to commit to localStorage when this reserve is consumed. */
  nextAnchorHistory: string[];
  nextPicksHistory: string[];
};
let _becauseReserve: BecauseReserve | null = null;
let _becauseReserveFilling = false;

/** Helper: read a JSON string[] from localStorage, returning [] on any failure. */
function readJsonArray(key: string | null): string[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Resolve a set of album picks for one anchor candidate. */
async function resolvePicks(
  candidate: BecauseYouLikeAnchor,
  recentPicks: Set<string>,
  scopes: readonly LibraryBrowseScopePair[],
): Promise<SubsonicAlbum[] | null> {
  const info = await getArtistInfoForServer(candidate.serverId, candidate.id, {
    similarArtistCount: SIMILAR_FETCH,
  });
  const similar = (info.similarArtist ?? []).filter(s => s.id);
  if (similar.length === 0) return null;

  const sampled = shuffleArray(similar).slice(0, SIMILAR_PICK);
  const libraryIds = browseScopeLibraryIdsForServer(scopes, candidate.serverId);
  const results = await Promise.all(
    sampled.map(s => getArtistForServer(candidate.serverId, s.id, { libraryIds }).catch(() => null)),
  );

  const picks: SubsonicAlbum[] = [];
  for (const r of results) {
    if (!r) continue;
    const albums = r.albums.map(album => ({ ...album, serverId: candidate.serverId }));
    if (albums.length === 0) continue;
    const fresh = albums.filter(a => !recentPicks.has(ownedEntityKey(candidate.serverId, a.id)));
    const choice = fresh.length > 0 ? fresh : albums;
    const album = choice[Math.floor(Math.random() * choice.length)];
    picks.push(album);
    if (picks.length >= SHOW_COUNT) break;
  }
  return picks.length > 0 ? picks : null;
}

type FetchBecauseResult = {
  anchor: BecauseYouLikeAnchor;
  recs: SubsonicAlbum[];
  nextAnchorHistory: string[];
  nextPicksHistory: string[];
};

type FetchBecauseOutcome =
  | { status: 'ready'; result: FetchBecauseResult }
  | { status: 'empty' | 'error' };

/**
 * Core fetch: rotate anchor, call Last.fm / Subsonic, return result + updated
 * rotation snapshots. Does NOT touch React state or localStorage — callers do that.
 * Reads the CURRENT localStorage values so it always reflects the latest rotation.
 */
async function fetchBecauseYouLike(
  pool: BecauseYouLikeAnchor[],
  scopes: readonly LibraryBrowseScopePair[],
  anchorHistKey: string | null,
  picksHistKey: string | null,
): Promise<FetchBecauseOutcome> {
  const anchorHistory = readJsonArray(anchorHistKey);
  const picksHistory = readJsonArray(picksHistKey);

  const cooldown = Math.min(ANCHOR_COOLDOWN, Math.max(0, Math.floor(pool.length / 2)));
  const recentAnchors = new Set(anchorHistory.slice(-cooldown));
  const eligibleRaw = pool.filter(a => !recentAnchors.has(anchorKey(a)));
  const eligible = eligibleRaw.length > 0 ? eligibleRaw : pool.slice();
  const candidates = shuffleArray(eligible);
  const recentPicks = new Set(picksHistory);

  const tries = Math.min(ANCHOR_MAX_TRIES, candidates.length);
  const tryList = candidates.slice(0, tries);
  let hadError = false;

  const buildResult = (candidate: BecauseYouLikeAnchor, picks: SubsonicAlbum[]): FetchBecauseResult => ({
    anchor: candidate,
    recs: picks,
    nextAnchorHistory: [...anchorHistory, anchorKey(candidate)].slice(-ANCHOR_COOLDOWN),
    nextPicksHistory: [
      ...picksHistory,
      ...picks.map(p => ownedEntityKey(p.serverId ?? candidate.serverId, p.id)),
    ].slice(-PICKS_HISTORY_SIZE),
  });

  /** First two shuffled anchors in parallel — cuts cold-start wait on slow Last.fm. */
  if (tryList.length >= 2) {
    const raced = await Promise.all(
      tryList.slice(0, 2).map(async candidate => {
        try {
          const picks = await resolvePicks(candidate, recentPicks, scopes);
          return picks ? { candidate, picks } : null;
        } catch {
          hadError = true;
          return null;
        }
      }),
    );
    const hit = raced.find((r): r is { candidate: BecauseYouLikeAnchor; picks: SubsonicAlbum[] } => r != null);
    if (hit) return { status: 'ready', result: buildResult(hit.candidate, hit.picks) };
  }

  for (const candidate of tryList) {
    try {
      const picks = await resolvePicks(candidate, recentPicks, scopes);
      if (!picks) continue;
      return { status: 'ready', result: buildResult(candidate, picks) };
    } catch {
      hadError = true;
      /* try next anchor */
    }
  }

  return { status: hadError ? 'error' : 'empty' };
}

/**
 * Fire-and-forget: fetch the next batch in the background so the next visit is
 * instant. localStorage rotation is NOT updated here — the snapshots are stored
 * in the reserve and applied only when the reserve is consumed.
 * Covers are NOT pre-warmed here (avoids bumpDiskSrcCache side-effects on the
 * currently-visible page); they are warmed via primeAlbumCoversForDisplay on consume.
 */
async function fillBecauseReserve(
  pool: BecauseYouLikeAnchor[],
  scopeKey: string,
  scopeVersion: number,
  scopes: readonly LibraryBrowseScopePair[],
  anchorHistKey: string | null,
  picksHistKey: string | null,
): Promise<void> {
  if (_becauseReserveFilling) return;
  _becauseReserveFilling = true;
  try {
    const outcome = await fetchBecauseYouLike(pool, scopes, anchorHistKey, picksHistKey);
    if (outcome.status === 'ready') {
      const { result } = outcome;
      _becauseReserve = { scopeKey, scopeVersion, ...result };
      // Also refresh the session snapshot so a quick leave→return can pick up
      // newer cards even before the reserve is explicitly consumed.
      writeBecauseYouLikeCache({ scopeKey, scopeVersion, anchor: result.anchor, recs: result.recs });
    }
  } catch {
    /* Network failure — next visit falls back to a fresh fetch. */
  } finally {
    _becauseReserveFilling = false;
  }
}

/** One classic because-card shell, then extra grid slots fill in. */
function useBecauseRowSlotCount(active: boolean, max = SHOW_COUNT): number {
  const [count, setCount] = useState(1);

  useEffect(() => {
    if (!active) {
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCount(1);
      return;
    }
    setCount(1);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let slot = 2; slot <= max; slot += 1) {
      timers.push(setTimeout(() => setCount(slot), ROW_STAGGER_MS * (slot - 1)));
    }
    return () => timers.forEach(clearTimeout);
  }, [active, max]);

  return count;
}

/** Lead placeholder — same shell as a loaded because-card (cover + text block). */
function BecauseCardSkeletonLead() {
  return (
    <div className="because-card because-card--skeleton because-card--skeleton-lead" aria-hidden="true">
      <div className="because-card-cover-wrap">
        <div className="because-card-cover because-card-cover-placeholder" />
      </div>
      <div className="because-card-text">
        <div className="because-card-top">
          <div className="because-card-skeleton-line because-card-skeleton-line--similar" />
          <div className="because-card-skeleton-line because-card-skeleton-line--title" />
          <div className="because-card-skeleton-line because-card-skeleton-line--artist" />
          <div className="because-card-skeleton-line because-card-skeleton-line--meta" />
        </div>
      </div>
    </div>
  );
}

/** Extra grid slots — cover tile only, fills in beside the lead card. */
function BecauseCardSkeletonSlot({ enter }: { enter?: boolean }) {
  return (
    <div
      className={`because-card because-card--skeleton because-card--skeleton-slot${
        enter ? ' because-card--slot-enter' : ''
      }`}
      aria-hidden="true"
    >
      <div className="because-card-cover-wrap">
        <div className="because-card-cover because-card-cover-placeholder" />
      </div>
    </div>
  );
}

function BecauseYouLikeSkeleton({ title, slotCount }: { title: string; slotCount: number }) {
  return (
    <section className="album-row-section because-you-like-rail">
      <div className="album-row-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>
          {title}
        </h2>
      </div>
      <div className="because-card-grid because-card-grid--stagger">
        {slotCount >= 1 ? <BecauseCardSkeletonLead /> : null}
        {slotCount >= 2 ? <BecauseCardSkeletonSlot enter /> : null}
        {slotCount >= 3 ? <BecauseCardSkeletonSlot enter /> : null}
      </div>
    </section>
  );
}

interface Props {
  mostPlayed: SubsonicAlbum[];
  recentlyPlayed?: SubsonicAlbum[];
  starred?: SubsonicAlbum[];
  scopeKey: string;
  scopeVersion: number;
  scopes: readonly LibraryBrowseScopePair[];
  disableArtwork?: boolean;
  onDiagnosticResult?: (result: BecauseYouLikeDiagnosticResult) => void;
}

export type BecauseYouLikeDiagnosticResult = {
  status: 'loading' | 'ready' | 'empty' | 'error' | 'timeout';
  durationMs?: number;
  itemCount?: number;
  detail?: string;
};

/** Round-robin merge of multiple album sources, dedup by owner + artistId.
 *  Cycling sources (most-played, recently-played, starred) means the per-mount
 *  rotation cursor visits a different listening *mode* each visit instead of
 *  walking only down the top-played list. */
// Exported for the focused owner-identity test below this feature boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function buildAnchorPool(sources: SubsonicAlbum[][], limit: number): BecauseYouLikeAnchor[] {
  const seen = new Set<string>();
  const out: BecauseYouLikeAnchor[] = [];
  const maxLen = sources.reduce((m, s) => Math.max(m, s.length), 0);
  for (let i = 0; i < maxLen && out.length < limit; i++) {
    for (const src of sources) {
      if (out.length >= limit) break;
      const a = src[i];
      if (!a?.artistId || !a.serverId) continue;
      const key = ownedEntityKey(a.serverId, a.artistId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: a.artistId, name: a.artist, serverId: a.serverId });
    }
  }
  return out;
}


function ownedEntityKey(serverId: string, id: string): string {
  return `${serverId}:${id}`;
}

function anchorKey(anchor: BecauseYouLikeAnchor): string {
  return ownedEntityKey(anchor.serverId, anchor.id);
}

/** Rotation memories follow the complete mixed-server browse scope. */
function anchorHistoryKey(scopeKey: string): string | null {
  return scopeKey ? `${ANCHOR_HISTORY_KEY_PREFIX}${scopeKey}` : null;
}
function picksHistoryKey(scopeKey: string): string | null {
  return scopeKey ? `${PICKS_HISTORY_KEY_PREFIX}${scopeKey}` : null;
}

function hasValidReserve(scopeKey: string, scopeVersion: number): boolean {
  return (
    _becauseReserve != null &&
    _becauseReserve.scopeKey === scopeKey &&
    _becauseReserve.scopeVersion === scopeVersion
  );
}

export default function BecauseYouLikeRail({
  mostPlayed,
  recentlyPlayed,
  starred,
  scopeKey,
  scopeVersion,
  scopes,
  disableArtwork = false,
  onDiagnosticResult,
}: Props) {
  const { t } = useTranslation();
  const pool = useMemo(
    () => buildAnchorPool([mostPlayed, recentlyPlayed ?? [], starred ?? []], TOP_ARTIST_POOL),
    [mostPlayed, recentlyPlayed, starred],
  );
  const poolKey = useMemo(
    () => pool.slice(0, 8).map(anchorKey).join('\u0001'),
    [pool],
  );
  // Initialise state in priority order: reserve (new batch) > session cache (stale-while-
  // revalidate) > skeleton. Both checks work without poolKey so they fire correctly on the
  // first render when pool is still [] (Home.tsx loads mostPlayed asynchronously).
  const [anchor, setAnchor] = useState<BecauseYouLikeAnchor | null>(() => {
    if (hasValidReserve(scopeKey, scopeVersion)) return _becauseReserve!.anchor;
    return readBecauseYouLikeCache(scopeKey, scopeVersion)?.anchor ?? null;
  });
  const [recs, setRecs] = useState<SubsonicAlbum[]>(() => {
    if (hasValidReserve(scopeKey, scopeVersion)) return _becauseReserve!.recs;
    return readBecauseYouLikeCache(scopeKey, scopeVersion)?.recs ?? [];
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const diagnosticGenerationRef = useRef(0);
  const [narrow, setNarrow] = useState(false);
  const [refreshing, setRefreshing] = useState(() => {
    if (hasValidReserve(scopeKey, scopeVersion)) return false;
    const snap = readBecauseYouLikeCache(scopeKey, scopeVersion);
    return !snap || snap.recs.length === 0;
  });
  const reportDiagnostic = useEffectEvent((result: BecauseYouLikeDiagnosticResult) => {
    onDiagnosticResult?.(result);
  });
  const skeletonSlots = useBecauseRowSlotCount(refreshing, SHOW_COUNT);
  const contentReady = !refreshing && Boolean(anchor) && recs.length > 0;
  const contentSlots = contentReady ? recs.length : 1;

  /** On every navigation / server / pool change: apply reserve immediately
   *  (synchronous, before browser paint) or fall back to session cache (stale-
   *  while-revalidate), only clearing to skeleton when nothing is available. */
  useLayoutEffect(() => {
    if (hasValidReserve(scopeKey, scopeVersion)) {
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnchor(_becauseReserve!.anchor);
      setRecs(_becauseReserve!.recs);
      setRefreshing(false);
    } else {
      const snap = readBecauseYouLikeCache(scopeKey, scopeVersion);
      if (snap && snap.recs.length > 0) {
        setAnchor(snap.anchor);
        setRecs(snap.recs);
        setRefreshing(false);
      } else {
        setRefreshing(true);
        setAnchor(null);
        setRecs([]);
      }
    }
  }, [scopeKey, scopeVersion, poolKey]);

  // 696px ≙ exactly 2 BecauseCards side-by-side (2*340 + 16 gap). Below that
  // the hero-style cards stretch full-width and dwarf the rest of the page,
  // so we swap in a standard AlbumRow which is already perf-tuned for narrow
  // rails (artwork budget, viewport windowing, scroll-paging).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateNarrow = (width: number) => {
      setNarrow(current => {
        const nextNarrow = current
          ? width < NARROW_EXIT_WIDTH
          : width < NARROW_ENTER_WIDTH;
        return current === nextNarrow ? current : nextNarrow;
      });
    };
    updateNarrow(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        updateNarrow(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (pool.length === 0) {
      // Pool is still being loaded (Home.tsx fetches data asynchronously). Do not
      // run the fetch/reserve logic yet — useLayoutEffect already shows reserve or
      // cache content. The effect will re-run once pool is populated.
      return;
    }
    if (!scopeKey) {
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnchor(null);
      setRecs([]);
      setRefreshing(false);
      return;
    }

    const anchorHistKey = anchorHistoryKey(scopeKey);
    const picksHistKey = picksHistoryKey(scopeKey);
    const snap = readBecauseYouLikeCache(scopeKey, scopeVersion);
    const startedAt = performance.now();
    const generation = ++diagnosticGenerationRef.current;
    const reportFinal = (
      status: BecauseYouLikeDiagnosticResult['status'],
      itemCount: number,
      detail: string,
    ) => {
      if (cancelled) return;
      reportDiagnostic({
        status,
        durationMs: performance.now() - startedAt,
        itemCount,
        detail: `generation ${generation}: ${detail}`,
      });
    };
    reportDiagnostic({ status: 'loading', detail: `generation ${generation}: pool ${pool.length}` });

    // Consume module-level reserve (keyed by the complete library scope).
    const reserved = hasValidReserve(scopeKey, scopeVersion) ? _becauseReserve : null;
    _becauseReserve = null;

    (async () => {
      if (reserved) {
        // ── Reserve path: instant display, no network ──────────────────────
        reportFinal('ready', reserved.recs.length, 'reserve');
        await primeAlbumCoversForDisplay(reserved.recs, BECAUSE_CARD_COVER_CSS_PX, {
          limit: SHOW_COUNT,
          disabled: disableArtwork,
        });
        if (cancelled) return;
        // Advance rotation in localStorage now that these picks are being shown.
        try {
          if (anchorHistKey) localStorage.setItem(anchorHistKey, JSON.stringify(reserved.nextAnchorHistory));
          if (picksHistKey) localStorage.setItem(picksHistKey, JSON.stringify(reserved.nextPicksHistory));
        } catch { /* ignore */ }
        setAnchor(reserved.anchor);
        setRecs(reserved.recs);
        writeBecauseYouLikeCache({
          scopeKey,
          scopeVersion,
          anchor: reserved.anchor,
          recs: reserved.recs,
        });
        setRefreshing(false);
        // Pre-fetch the next batch so the next visit is also instant.
        void fillBecauseReserve(pool, scopeKey, scopeVersion, scopes, anchorHistKey, picksHistKey);
        return;
      }

      // Keep visible cards stable on return visits: if we already have a valid
      // session snapshot, leave it on screen and only prefetch the next batch
      // for the next mount instead of swapping cards mid-visit.
      if (snap && snap.recs.length > 0) {
        reportFinal('ready', snap.recs.length, 'cache');
        setRefreshing(false);
        void fillBecauseReserve(pool, scopeKey, scopeVersion, scopes, anchorHistKey, picksHistKey);
        return;
      }

      // ── Full-fetch path (first visit or reserve miss) ──────────────────
      // Only clear to skeleton if nothing is currently displayed. When cached
      // content is visible, leave it in place and swap silently (stale-while-
      // revalidate) — better UX than flashing a skeleton for a network round-trip.
      if (!snap || snap.recs.length === 0) {
        setRefreshing(true);
        setAnchor(null);
        setRecs([]);
      }

      let outcome: FetchBecauseOutcome;
      try {
        outcome = await fetchBecauseYouLike(pool, scopes, anchorHistKey, picksHistKey);
      } catch (error) {
        reportFinal('error', 0, error instanceof Error ? error.message : 'network');
        if (!cancelled) {
          setAnchor(null);
          setRecs([]);
          setRefreshing(false);
        }
        return;
      }
      if (cancelled) return;

      if (outcome.status === 'ready') {
        const { result } = outcome;
        reportFinal('ready', result.recs.length, 'network');
        await primeAlbumCoversForDisplay(result.recs, BECAUSE_CARD_COVER_CSS_PX, {
          limit: SHOW_COUNT,
          disabled: disableArtwork,
        });
        if (cancelled) return;
        try {
          if (anchorHistKey) localStorage.setItem(anchorHistKey, JSON.stringify(result.nextAnchorHistory));
          if (picksHistKey) localStorage.setItem(picksHistKey, JSON.stringify(result.nextPicksHistory));
        } catch { /* ignore */ }
        setAnchor(result.anchor);
        setRecs(result.recs);
        writeBecauseYouLikeCache({
          scopeKey,
          scopeVersion,
          anchor: result.anchor,
          recs: result.recs,
        });
        setRefreshing(false);
        // Pre-fetch next batch so the next visit is instant.
        void fillBecauseReserve(pool, scopeKey, scopeVersion, scopes, anchorHistKey, picksHistKey);
      } else {
        reportFinal(outcome.status, 0, 'network');
        // Network failed — restore session cache if available.
        if (snap) {
          await primeAlbumCoversForDisplay(snap.recs, BECAUSE_CARD_COVER_CSS_PX, {
            limit: SHOW_COUNT,
            disabled: disableArtwork,
          });
          if (cancelled) return;
          setAnchor(snap.anchor);
          setRecs(snap.recs);
        } else if (!cancelled) {
          setAnchor(null);
          setRecs([]);
        }
        if (!cancelled) setRefreshing(false);
      }
    })();

    return () => { cancelled = true; };
    // Gate on poolKey (the stable top-anchor identity), not the `pool` array ref.
    // `pool` is rebuilt whenever Home's mostPlayed changes, so loading more Most
    // Played albums (which feeds this pool) would otherwise re-run this effect and
    // swap the cards — a height blip above the row that scroll anchoring turns into
    // an upward viewport jump. The sibling reserve effect already keys on poolKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey, scopeKey, scopeVersion, disableArtwork]);

  useLibraryCoverPrefetch(
    disableArtwork || recs.length === 0 ? [] : [{ albums: recs, priority: 'high' }],
    [recs, disableArtwork],
  );

  if (pool.length === 0) {
    return <div ref={containerRef} />;
  }

  if (refreshing || !anchor || recs.length === 0) {
    if (!refreshing && (!anchor || recs.length === 0)) {
      return <div ref={containerRef} />;
    }
    return (
      <div ref={containerRef}>
        <BecauseYouLikeSkeleton title={t('home.becauseYouLike')} slotCount={skeletonSlots} />
      </div>
    );
  }

  const sectionTitle = t('home.becauseYouLikeFor', { artist: anchor.name });

  return (
    <div ref={containerRef}>
      {narrow ? (
        <AlbumRow title={sectionTitle} albums={recs} disableArtwork={disableArtwork} />
      ) : (
        <section className="album-row-section because-you-like-rail">
          <div className="album-row-header">
            <h2 className="section-title" style={{ marginBottom: 0 }}>
              {sectionTitle}
            </h2>
          </div>
          <div className="because-card-grid because-card-grid--stagger">
            {recs.slice(0, contentSlots).map((album, index) => (
              <BecauseCard
                key={ownedEntityKey(album.serverId ?? anchor.serverId, album.id)}
                album={album}
                anchor={anchor.name}
                disableArtwork={disableArtwork}
                enter={index > 0}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface CardProps {
  album: SubsonicAlbum;
  anchor: string;
  disableArtwork: boolean;
  enter?: boolean;
}

const BecauseCard = memo(function BecauseCard({ album, anchor, disableArtwork, enter }: CardProps) {
  const { t } = useTranslation();
  const ownerServerId = album.serverId;
  const { isHolding, pressBind } = useLongPressAction({
    onShortPress: () => playAlbum(album.id, ownerServerId ? { serverId: ownerServerId } : undefined),
    onLongPress: () => playAlbumShuffled(album.id, ownerServerId ? { serverId: ownerServerId } : undefined),
  });
  const navigateToAlbum = useNavigateToAlbum();
  const enqueue = usePlayerStore(s => s.enqueue);
  const coverServerScope = useMemo(
    () => coverServerScopeForServerId(ownerServerId),
    [ownerServerId],
  );
  const coverRef = useAlbumCoverRef(album.id, album.coverArt, coverServerScope, { libraryResolve: false });
  const coverHandle = useCoverArt(coverRef, BECAUSE_CARD_COVER_CSS_PX, {
    surface: 'dense',
    ensurePriority: 'high',
  });
  const imgSrc = coverImgSrc(coverHandle.src);
  const bgResolved = coverHandle.src;
  const artistLabel = useMemo(() => albumArtistDisplayName(album), [album]);
  const handleOpen = () => navigateToAlbum(album.id, {
    search: appendServerQuery(undefined, ownerServerId),
  });
  const handleEnqueue = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (!ownerServerId) return;
      const serverId = resolveMediaServerId(ownerServerId);
      if (!serverId) return;
      const data = await resolveAlbum(serverId, album.id);
      if (!data) return;
      enqueue(data.songs.map(song => ({ ...songToTrack(song), serverId })));
    } catch {
      /* silent — toast would be too noisy for a hover action */
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={`because-card${enter ? ' because-card--slot-enter' : ''}`}
      onClick={handleOpen}
      onKeyDown={e => { if (e.key === 'Enter') handleOpen(); }}
      aria-label={`${album.name} – ${artistLabel}`}
    >
      {!disableArtwork && bgResolved && (
        <div
          className="because-card-bg"
          style={{ backgroundImage: `url(${bgResolved})` }}
          aria-hidden="true"
        />
      )}
      <div className="because-card-cover-wrap">
        {!disableArtwork && album.coverArt ? (
          imgSrc ? (
            <img
              src={imgSrc}
              alt={album.name}
              className="because-card-cover"
              loading="eager"
              decoding="sync"
              onError={coverHandle.onImgError}
            />
          ) : (
            <div
              className="because-card-cover because-card-cover-placeholder because-card-cover-loading"
              aria-hidden="true"
            />
          )
        ) : (
          <div className="because-card-cover because-card-cover-placeholder" aria-hidden="true">
            <Music size={42} strokeWidth={1.5} />
          </div>
        )}
        <div className="album-card-play-overlay">
          <button
            type="button"
            className="album-card-details-btn long-press-play-btn"
            {...pressBind}
            aria-label={t('hero.playAlbum')}
            data-tooltip={t('hero.playAlbumTooltip')}
            data-tooltip-pos="top"
          >
            <LongPressWaveOverlay active={isHolding} size="compact" />
            <span className="long-press-play-btn__icon">
              <Play size={15} fill="currentColor" />
            </span>
          </button>
          <button
            type="button"
            className="album-card-details-btn"
            onClick={handleEnqueue}
            aria-label={t('contextMenu.enqueueAlbum')}
            data-tooltip={t('contextMenu.enqueueAlbum')}
            data-tooltip-pos="top"
          >
            <ListPlus size={15} />
          </button>
        </div>
      </div>
      <div className="because-card-text">
        <div className="because-card-top">
          <div className="because-card-similar">
            {t('home.similarTo', { artist: anchor })}
          </div>
          <div className="because-card-title">{album.name}</div>
          <div className="because-card-artist">{artistLabel}</div>
        </div>
        {album.releaseTypes && album.releaseTypes[0] ? (
          <div className="because-card-pills">
            <span className="because-card-pill because-card-pill-type">{album.releaseTypes[0]}</span>
          </div>
        ) : null}
        <div className="because-card-meta">
          {album.year ? <span>{album.year}</span> : null}
          {album.songCount ? <span>{t('home.becauseYouLikeTracks', { count: album.songCount })}</span> : null}
          {album.duration ? <span>{formatHumanHoursMinutes(album.duration)}</span> : null}
        </div>
      </div>
    </div>
  );
});
