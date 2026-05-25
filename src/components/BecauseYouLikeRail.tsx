import { getArtist, getArtistInfo } from '../api/subsonicArtists';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import { shuffleArray } from '../utils/playback/shuffleArray';
import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play, ListPlus, Music } from 'lucide-react';
import { coverArtRef } from '../cover/ref';
import { coverPrefetchRegister } from '../cover/prefetchRegistry';
import { coverImgSrc } from '../cover/imgSrc';
import { useCoverArt } from '../cover/useCoverArt';
import { primeAlbumCoversForDisplay } from '../cover/warmDiskPeek';
import {
  readBecauseYouLikeCache,
  writeBecauseYouLikeCache,
  type BecauseYouLikeAnchor,
} from '../store/becauseYouLikeCache';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { playAlbum } from '../utils/playback/playAlbum';
import { formatHumanHoursMinutes } from '../utils/format/formatHumanDuration';
import AlbumRow from './AlbumRow';

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

/** One classic because-card shell, then extra grid slots fill in. */
function useBecauseRowSlotCount(active: boolean, max = SHOW_COUNT): number {
  const [count, setCount] = useState(1);

  useEffect(() => {
    if (!active) {
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
  disableArtwork?: boolean;
}

/** Round-robin merge of multiple album sources, dedup by artistId.
 *  Cycling sources (most-played, recently-played, starred) means the per-mount
 *  rotation cursor visits a different listening *mode* each visit instead of
 *  walking only down the top-played list. */
function buildAnchorPool(sources: SubsonicAlbum[][], limit: number): BecauseYouLikeAnchor[] {
  const seen = new Set<string>();
  const out: BecauseYouLikeAnchor[] = [];
  const maxLen = sources.reduce((m, s) => Math.max(m, s.length), 0);
  for (let i = 0; i < maxLen && out.length < limit; i++) {
    for (const src of sources) {
      if (out.length >= limit) break;
      const a = src[i];
      if (!a || !a.artistId || seen.has(a.artistId)) continue;
      seen.add(a.artistId);
      out.push({ id: a.artistId, name: a.artist });
    }
  }
  return out;
}


/** Both rotation memories are **per-server** — server A and server B keep
 *  independent state, so switching servers doesn't snap the anchor cooldown
 *  or the recently-shown-album buffer onto the new server's content. */
function anchorHistoryKey(serverId: string | null): string | null {
  return serverId ? `${ANCHOR_HISTORY_KEY_PREFIX}${serverId}` : null;
}
function picksHistoryKey(serverId: string | null): string | null {
  return serverId ? `${PICKS_HISTORY_KEY_PREFIX}${serverId}` : null;
}
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

export default function BecauseYouLikeRail({
  mostPlayed,
  recentlyPlayed,
  starred,
  disableArtwork = false,
}: Props) {
  const { t } = useTranslation();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const pool = useMemo(
    () => buildAnchorPool([mostPlayed, recentlyPlayed ?? [], starred ?? []], TOP_ARTIST_POOL),
    [mostPlayed, recentlyPlayed, starred],
  );
  const poolKey = useMemo(
    () => pool.slice(0, 8).map(a => a.id).join('\u0001'),
    [pool],
  );
  const location = useLocation();
  const [anchor, setAnchor] = useState<BecauseYouLikeAnchor | null>(null);
  const [recs, setRecs] = useState<SubsonicAlbum[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const skeletonSlots = useBecauseRowSlotCount(refreshing, SHOW_COUNT);
  const contentReady = !refreshing && Boolean(anchor) && recs.length > 0;
  const contentSlots = useBecauseRowSlotCount(contentReady, recs.length);

  /** Drop stale cards/text before the next paint when revisiting Mainstage or refetching seeds. */
  useLayoutEffect(() => {
    setRefreshing(true);
    setAnchor(null);
    setRecs([]);
  }, [location.key, activeServerId, poolKey]);

  // 696px ≙ exactly 2 BecauseCards side-by-side (2*340 + 16 gap). Below that
  // the hero-style cards stretch full-width and dwarf the rest of the page,
  // so we swap in a standard AlbumRow which is already perf-tuned for narrow
  // rails (artwork budget, viewport windowing, scroll-paging).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setNarrow(entry.contentRect.width < 696);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (pool.length === 0) {
      setAnchor(null);
      setRecs([]);
      setRefreshing(false);
      return;
    }

    setRefreshing(true);
    setAnchor(null);
    setRecs([]);

    const snap = readBecauseYouLikeCache(activeServerId);

    const anchorHistKey = anchorHistoryKey(activeServerId);
    const picksHistKey = picksHistoryKey(activeServerId);
    const anchorHistory = readJsonArray(anchorHistKey);
    const picksHistory = readJsonArray(picksHistKey);

    /** Cooldown caps at half the pool size so a small library doesn't soft-lock
     *  itself out (a server with 4 anchor-eligible artists shouldn't be told
     *  "the last 5 are forbidden"). */
    const cooldown = Math.min(ANCHOR_COOLDOWN, Math.max(0, Math.floor(pool.length / 2)));
    const recentAnchors = new Set(anchorHistory.slice(-cooldown));
    const eligibleRaw = pool.filter(a => !recentAnchors.has(a.id));
    const eligible = eligibleRaw.length > 0 ? eligibleRaw : pool.slice();
    const candidates = shuffleArray(eligible);
    const recentPicks = new Set(picksHistory);

    const resolvePicks = async (candidate: BecauseYouLikeAnchor): Promise<SubsonicAlbum[] | null> => {
      const info = await getArtistInfo(candidate.id, { similarArtistCount: SIMILAR_FETCH });
      const similar = (info.similarArtist ?? []).filter(s => s.id);
      if (similar.length === 0) return null;

      const sampled = shuffleArray(similar).slice(0, SIMILAR_PICK);
      const results = await Promise.all(sampled.map(s => getArtist(s.id).catch(() => null)));

      const picks: SubsonicAlbum[] = [];
      for (const r of results) {
        if (!r || r.albums.length === 0) continue;
        const fresh = r.albums.filter(a => !recentPicks.has(a.id));
        const choice = fresh.length > 0 ? fresh : r.albums;
        const album = choice[Math.floor(Math.random() * choice.length)];
        picks.push(album);
        if (picks.length >= SHOW_COUNT) break;
      }
      return picks.length > 0 ? picks : null;
    };

    const commitSuccess = async (candidate: BecauseYouLikeAnchor, picks: SubsonicAlbum[]) => {
      await primeAlbumCoversForDisplay(picks, BECAUSE_CARD_COVER_CSS_PX, {
        limit: SHOW_COUNT,
        disabled: disableArtwork,
      });
      if (cancelled) return;

      const newAnchorHistory = [...anchorHistory, candidate.id].slice(-ANCHOR_COOLDOWN);
      const newPicksHistory = [...picksHistory, ...picks.map(p => p.id)].slice(-PICKS_HISTORY_SIZE);
      try {
        if (anchorHistKey) localStorage.setItem(anchorHistKey, JSON.stringify(newAnchorHistory));
        if (picksHistKey) localStorage.setItem(picksHistKey, JSON.stringify(newPicksHistory));
      } catch { /* ignore */ }
      setAnchor(candidate);
      setRecs(picks);
      if (activeServerId) {
        writeBecauseYouLikeCache({ serverId: activeServerId, anchor: candidate, recs: picks });
      }
      setRefreshing(false);
    };

    const applySnapFallback = async () => {
      if (!snap || cancelled) return false;
      await primeAlbumCoversForDisplay(snap.recs, BECAUSE_CARD_COVER_CSS_PX, {
        limit: SHOW_COUNT,
        disabled: disableArtwork,
      });
      if (cancelled) return false;
      setAnchor(snap.anchor);
      setRecs(snap.recs);
      return true;
    };

    (async () => {
      let success = false;
      const tries = Math.min(ANCHOR_MAX_TRIES, candidates.length);
      const tryList = candidates.slice(0, tries);

      /** First two shuffled anchors in parallel — cuts cold-start wait on slow Last.fm. */
      if (tryList.length >= 2) {
        const raced = await Promise.all(
          tryList.slice(0, 2).map(async candidate => {
            try {
              const picks = await resolvePicks(candidate);
              return picks ? { candidate, picks } : null;
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        const hit = raced.find(
          (r): r is { candidate: BecauseYouLikeAnchor; picks: SubsonicAlbum[] } => r != null,
        );
        if (hit) {
          await commitSuccess(hit.candidate, hit.picks);
          success = true;
        }
      }

      if (!success) {
        for (const candidate of tryList) {
          if (cancelled) return;
          try {
            const picks = await resolvePicks(candidate);
            if (!picks) continue;
            await commitSuccess(candidate, picks);
            success = true;
            break;
          } catch {
            /* try next anchor */
          }
        }
      }

      if (!cancelled) {
        if (!success) {
          const restored = await applySnapFallback();
          if (!restored) {
            setAnchor(null);
            setRecs([]);
          }
        }
        setRefreshing(false);
      }
    })();

    return () => { cancelled = true; };
  }, [pool, activeServerId, disableArtwork, location.key, poolKey]);

  useEffect(() => {
    if (disableArtwork || recs.length === 0) return;
    const refs = recs.flatMap(a => (a.coverArt ? [coverArtRef(a.coverArt)] : []));
    return coverPrefetchRegister(refs, { surface: 'dense', priority: 'high' });
  }, [recs, disableArtwork]);

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
                key={album.id}
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
  const navigate = useNavigate();
  const enqueue = usePlayerStore(s => s.enqueue);
  const coverHandle = useCoverArt(album.coverArt, BECAUSE_CARD_COVER_CSS_PX, {
    surface: 'dense',
    ensurePriority: 'high',
  });
  const imgSrc = coverImgSrc(coverHandle.src);
  const bgResolved = coverHandle.src;
  const coverReady = disableArtwork || !album.coverArt || Boolean(imgSrc);
  const textReady = coverReady;

  const handleOpen = () => navigate(`/album/${album.id}`);
  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    playAlbum(album.id);
  };
  const handleEnqueue = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const data = await getAlbum(album.id);
      enqueue(data.songs.map(songToTrack));
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
      aria-label={`${album.name} – ${album.artist}`}
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
            className="album-card-details-btn"
            onClick={handlePlay}
            aria-label={t('hero.playAlbum')}
            data-tooltip={t('hero.playAlbum')}
            data-tooltip-pos="top"
          >
            <Play size={15} fill="currentColor" />
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
      {textReady ? (
      <div className="because-card-text">
        <div className="because-card-top">
          <div className="because-card-similar">
            {t('home.similarTo', { artist: anchor })}
          </div>
          <div className="because-card-title">{album.name}</div>
          <div className="because-card-artist">{album.artist}</div>
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
      ) : null}
    </div>
  );
});
