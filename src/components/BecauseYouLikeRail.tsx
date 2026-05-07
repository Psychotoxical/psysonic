import React, { memo, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play, ListPlus, Music } from 'lucide-react';
import {
  SubsonicAlbum,
  buildCoverArtUrl,
  coverArtCacheKey,
  getAlbum,
  getArtist,
  getArtistInfo,
} from '../api/subsonic';
import CachedImage, { useCachedUrl } from './CachedImage';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { playAlbum } from '../utils/playAlbum';

const ANCHOR_KEY_PREFIX = 'psysonic_because_anchor:';
const TOP_ARTIST_POOL = 12;
const SIMILAR_FETCH = 12;
const SIMILAR_PICK = 6;
const SHOW_COUNT = 3;
const COVER_SIZE = 300;

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

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

/** Anchor rotation memory is **per-server** — server A and server B keep
 *  independent rotation state, so switching servers doesn't snap the anchor
 *  back to the first artist of the new pool just because the previous server's
 *  anchor id was unknown there. */
function anchorKey(serverId: string | null): string | null {
  return serverId ? `${ANCHOR_KEY_PREFIX}${serverId}` : null;
}

function rotateAnchor(pool: Anchor[], serverId: string | null): Anchor | null {
  if (pool.length === 0) return null;
  const key = anchorKey(serverId);
  let lastId: string | null = null;
  if (key) {
    try { lastId = localStorage.getItem(key); } catch { /* ignore */ }
  }
  if (!lastId) return pool[0];
  const idx = pool.findIndex(a => a.id === lastId);
  if (idx < 0) return pool[0];
  return pool[(idx + 1) % pool.length];
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

  useEffect(() => {
    let cancelled = false;
    const next = rotateAnchor(pool, activeServerId);
    setAnchor(next);
    setRecs([]);
    if (!next) return;
    const key = anchorKey(activeServerId);
    if (key) {
      try { localStorage.setItem(key, next.id); } catch { /* ignore */ }
    }

    (async () => {
      try {
        const info = await getArtistInfo(next.id, { similarArtistCount: SIMILAR_FETCH });
        const similar = (info.similarArtist ?? []).filter(s => s.id);
        if (similar.length === 0) return;

        const candidates = shuffle(similar).slice(0, SIMILAR_PICK);
        const results = await Promise.all(
          candidates.map(s => getArtist(s.id).catch(() => null))
        );

        const picks: SubsonicAlbum[] = [];
        for (const r of results) {
          if (!r || r.albums.length === 0) continue;
          const album = r.albums[Math.floor(Math.random() * r.albums.length)];
          picks.push(album);
          if (picks.length >= SHOW_COUNT) break;
        }
        if (!cancelled) setRecs(picks);
      } catch {
        /* ignore */
      }
    })();

    return () => { cancelled = true; };
  }, [pool, activeServerId]);

  if (!anchor || recs.length === 0) return null;

  return (
    <section className="album-row-section because-you-like-rail">
      <div className="album-row-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>
          {t('home.becauseYouLikeFor', { artist: anchor.name })}
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
