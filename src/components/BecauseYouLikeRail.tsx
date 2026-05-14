import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { getArtist, getArtistInfo } from '../api/subsonicArtists';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import { shuffleArray } from '../utils/playback/shuffleArray';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play, ListPlus, Music } from 'lucide-react';
import CachedImage, { useCachedUrl } from './CachedImage';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { playAlbum } from '../utils/playback/playAlbum';
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
const COVER_SIZE = 300;

interface Anchor {
  id: string;
  name: string;
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
function buildAnchorPool(sources: SubsonicAlbum[][], limit: number): Anchor[] {
  const seen = new Set<string>();
  const out: Anchor[] = [];
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

function formatAlbumDuration(seconds: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours > 0) return t('common.durationHoursMinutes', { hours, minutes });
  return t('common.durationMinutesOnly', { minutes: totalMin });
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
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [recs, setRecs] = useState<SubsonicAlbum[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

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
      return;
    }

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

    (async () => {
      const tries = Math.min(ANCHOR_MAX_TRIES, candidates.length);
      /** Random pick (with cooldown) replaces deterministic round-robin so the
       *  same anchor doesn't surface every pool.length mounts. The retry loop
       *  still walks forward through the shuffled `candidates` list when the
       *  current pick is a dud (no Last.fm similar artists, or no library
       *  matches). On success: append the chosen anchor + chosen album ids to
       *  their respective ring buffers so future mounts see different stuff. */
      for (let i = 0; i < tries; i++) {
        if (cancelled) return;
        const candidate = candidates[i];
        try {
          const info = await getArtistInfo(candidate.id, { similarArtistCount: SIMILAR_FETCH });
          if (cancelled) return;
          const similar = (info.similarArtist ?? []).filter(s => s.id);
          if (similar.length === 0) continue;

          const sampled = shuffleArray(similar).slice(0, SIMILAR_PICK);
          const results = await Promise.all(
            sampled.map(s => getArtist(s.id).catch(() => null))
          );
          if (cancelled) return;

          const picks: SubsonicAlbum[] = [];
          for (const r of results) {
            if (!r || r.albums.length === 0) continue;
            /** Prefer an album not in the recently-shown buffer; fall back to
             *  *any* album when the artist's whole catalogue is in the buffer
             *  so the slot isn't lost. */
            const fresh = r.albums.filter(a => !recentPicks.has(a.id));
            const choice = fresh.length > 0 ? fresh : r.albums;
            const album = choice[Math.floor(Math.random() * choice.length)];
            picks.push(album);
            if (picks.length >= SHOW_COUNT) break;
          }
          if (picks.length === 0) continue;

          const newAnchorHistory = [...anchorHistory, candidate.id].slice(-ANCHOR_COOLDOWN);
          const newPicksHistory = [...picksHistory, ...picks.map(p => p.id)].slice(-PICKS_HISTORY_SIZE);
          try {
            if (anchorHistKey) localStorage.setItem(anchorHistKey, JSON.stringify(newAnchorHistory));
            if (picksHistKey) localStorage.setItem(picksHistKey, JSON.stringify(newPicksHistory));
          } catch { /* ignore */ }
          setAnchor(candidate);
          setRecs(picks);
          return;
        } catch {
          /* network / server error — try next anchor */
        }
      }
      if (!cancelled) {
        setAnchor(null);
        setRecs([]);
      }
    })();

    return () => { cancelled = true; };
  }, [pool, activeServerId]);

  if (!anchor || recs.length === 0) {
    return <div ref={containerRef} />;
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
          <div className="because-card-grid">
            {recs.map(album => (
              <BecauseCard
                key={album.id}
                album={album}
                anchor={anchor.name}
                disableArtwork={disableArtwork}
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
}

const BecauseCard = memo(function BecauseCard({ album, anchor, disableArtwork }: CardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const enqueue = usePlayerStore(s => s.enqueue);
  const coverUrl = useMemo(
    () => (album.coverArt ? buildCoverArtUrl(album.coverArt, COVER_SIZE) : ''),
    [album.coverArt],
  );
  const coverKey = useMemo(
    () => (album.coverArt ? coverArtCacheKey(album.coverArt, COVER_SIZE) : ''),
    [album.coverArt],
  );
  const bgResolved = useCachedUrl(coverUrl, coverKey);

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
      className="because-card"
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
        {!disableArtwork && coverUrl ? (
          <CachedImage
            src={coverUrl}
            cacheKey={coverKey}
            alt={album.name}
            className="because-card-cover"
            loading="lazy"
          />
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
          {album.duration ? <span>{formatAlbumDuration(album.duration, t)}</span> : null}
        </div>
      </div>
    </div>
  );
});
