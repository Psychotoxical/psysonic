import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Music, Star, ExternalLink, MicVocal, Heart, Cast, Users, Radio, Clock, SkipForward, Info, Headphones, Calendar, Disc3, TrendingUp, Play } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useLyricsStore } from '../store/lyricsStore';
import {
  buildCoverArtUrl, coverArtCacheKey, getSong, star, unstar,
  getAlbum, getArtist, getArtistInfo, getTopSongs,
  SubsonicSong, SubsonicArtistInfo, SubsonicAlbum,
} from '../api/subsonic';
import { songToTrack } from '../store/playerStore';
import {
  lastfmIsConfigured,
  lastfmGetTrackInfo, lastfmGetArtistStats,
  lastfmLoveTrack, lastfmUnloveTrack,
  type LastfmTrackInfo, type LastfmArtistStats,
} from '../api/lastfm';
import { fetchBandsintownEvents, type BandsintownEvent } from '../api/bandsintown';
import { useCachedUrl } from '../components/CachedImage';
import CachedImage from '../components/CachedImage';
import LastfmIcon from '../components/LastfmIcon';
import { useRadioMetadata } from '../hooks/useRadioMetadata';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function formatTotalDuration(s: number): string {
  if (!s || isNaN(s)) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, select, base, meta, link').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const val = attr.value.toLowerCase().trim();
      if (name.startsWith('on') || (name === 'href' && (val.startsWith('javascript:') || val.startsWith('data:'))) || (name === 'src' && (val.startsWith('javascript:') || val.startsWith('data:')))) {
        el.removeAttribute(attr.name);
      }
    });
  });
  // Strip trailing "Read more on Last.fm" style links for cleaner clamped bios.
  return doc.body.innerHTML.replace(/<a [^>]*>.*?<\/a>\.?\s*$/i, '').trim();
}

function isoToParts(iso: string): { month: string; day: string; weekday: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    month: d.toLocaleString(undefined, { month: 'short' }),
    day: String(d.getDate()),
    weekday: d.toLocaleString(undefined, { weekday: 'short' }),
    time: d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

interface ContributorRow { role: string; names: string[]; }

function buildContributorRows(song: SubsonicSong | null | undefined, mainArtistName: string): ContributorRow[] {
  if (!song?.contributors || song.contributors.length === 0) return [];
  const mainLower = mainArtistName.trim().toLowerCase();
  const rows = new Map<string, Set<string>>();
  for (const c of song.contributors) {
    const role = c.role?.trim();
    const name = c.artist?.name?.trim();
    if (!role || !name) continue;
    const label = c.subRole ? `${role} • ${c.subRole}` : role;
    let bucket = rows.get(label);
    if (!bucket) { bucket = new Set(); rows.set(label, bucket); }
    bucket.add(name);
  }
  const out: ContributorRow[] = [];
  for (const [role, names] of rows.entries()) {
    const list = Array.from(names);
    if (role.toLowerCase().startsWith('artist') && list.length === 1 && list[0].toLowerCase() === mainLower) continue;
    out.push({ role, names: list });
  }
  return out;
}

/**
 * Filter out the well-known Last.fm "no image" placeholder that Subsonic
 * backends aggregate into `largeImageUrl`/`mediumImageUrl` when no real
 * artist image exists. The placeholder MD5 is fixed and documented.
 */
function isRealArtistImage(url?: string): boolean {
  if (!url) return false;
  if (url.includes('2a96cbd8b46e442fc41c2b86b821562f')) return false;
  return true;
}

function renderStars(rating?: number) {
  if (!rating) return null;
  return (
    <div className="np-stars-inline">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={13}
          fill={i <= rating ? 'var(--ctp-yellow)' : 'none'}
          color={i <= rating ? 'var(--ctp-yellow)' : 'var(--ctp-overlay1)'}
        />
      ))}
    </div>
  );
}

// ─── Module-level TTL caches (shared across mounts) ───────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> { value: T; ts: number; }

function makeCache<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const e = map.get(key);
      if (!e) return undefined;
      if (Date.now() - e.ts > CACHE_TTL_MS) { map.delete(key); return undefined; }
      return e.value;
    },
    set(key: string, value: T) { map.set(key, { value, ts: Date.now() }); },
  };
}

const songMetaCache    = makeCache<SubsonicSong | null>();
const artistInfoCache  = makeCache<SubsonicArtistInfo | null>();
const albumCache       = makeCache<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>();
const topSongsCache    = makeCache<SubsonicSong[]>();
const tourCache        = makeCache<BandsintownEvent[]>();
const discographyCache = makeCache<SubsonicAlbum[]>();
const lfmTrackCache    = makeCache<LastfmTrackInfo | null>();
const lfmArtistCache   = makeCache<LastfmArtistStats | null>();

// ─── Subcomponents (all memoized) ─────────────────────────────────────────────

interface HeroProps {
  track: { title: string; artist: string; album: string; year?: number;
    duration: number; suffix?: string; bitRate?: number; samplingRate?: number;
    bitDepth?: number; artistId?: string; albumId?: string; id: string;
    userRating?: number; };
  genre?: string;
  playCount?: number;
  userRatingOverride?: number;
  lfmTrack: LastfmTrackInfo | null;
  lfmArtist: LastfmArtistStats | null;
  starred: boolean;
  lfmLoved: boolean;
  lfmLoveEnabled: boolean;
  activeLyricsTab: boolean;
  coverUrl: string;
  onNavigate: (path: string) => void;
  onToggleStar: () => void;
  onToggleLfmLove: () => void;
  onOpenLyrics: () => void;
}

const Hero = memo(function Hero({ track, genre, playCount, userRatingOverride, lfmTrack, lfmArtist, starred, lfmLoved, lfmLoveEnabled, activeLyricsTab, coverUrl, onNavigate, onToggleStar, onToggleLfmLove, onOpenLyrics }: HeroProps) {
  const { t } = useTranslation();
  const rating = userRatingOverride ?? track.userRating;
  const hiRes  = (track.bitDepth && track.bitDepth > 16) || (track.samplingRate && track.samplingRate > 48000);
  const releaseAge = track.year ? new Date().getFullYear() - track.year : 0;

  return (
    <div className="np-dash-hero">
      <div className="np-dash-hero-cover">
        {coverUrl
          ? <img src={coverUrl} alt="" className="np-cover" />
          : <div className="np-cover np-cover-fallback"><Music size={64} /></div>}
      </div>
      <div className="np-dash-hero-body">
        <div className="np-dash-hero-title">{track.title}</div>
        <div className="np-dash-hero-sub">
          <span className="np-link"
            onClick={() => track.artistId && onNavigate(`/artist/${track.artistId}`)}
            style={{ cursor: track.artistId ? 'pointer' : 'default' }}>
            {track.artist}
          </span>
          <span className="np-sep">·</span>
          <span className="np-link"
            onClick={() => track.albumId && onNavigate(`/album/${track.albumId}`)}
            style={{ cursor: track.albumId ? 'pointer' : 'default' }}>
            {track.album}
          </span>
          {track.year && <><span className="np-sep">·</span><span>{track.year}</span></>}
          {releaseAge > 0 && (
            <><span className="np-sep">·</span>
            <span className="np-dash-hero-age">
              {t('nowPlaying.releasedYearsAgo', { count: releaseAge, defaultValue: '{{count}} years ago' })}
            </span></>
          )}
        </div>

        <div className="np-dash-hero-badges">
          {genre && <span className="np-badge">{genre}</span>}
          {track.suffix && <span className="np-badge">{track.suffix.toUpperCase()}</span>}
          {track.bitRate && <span className="np-badge">{track.bitRate} kbps</span>}
          {track.samplingRate && <span className="np-badge">{(track.samplingRate / 1000).toFixed(1)} kHz</span>}
          {track.bitDepth && <span className="np-badge">{track.bitDepth}-bit</span>}
          {hiRes && <span className="np-badge np-badge-hires">Hi-Res</span>}
          {track.duration > 0 && <span className="np-badge">{formatTime(track.duration)}</span>}
        </div>

        <div className="np-dash-hero-actions">
          <button onClick={onToggleStar} className="np-dash-icon-btn"
            data-tooltip={starred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}>
            <Heart size={18} fill={starred ? 'var(--ctp-yellow)' : 'none'} color={starred ? 'var(--ctp-yellow)' : 'currentColor'} />
          </button>
          {lfmLoveEnabled && (
            <button onClick={onToggleLfmLove}
              className={`np-dash-icon-btn np-dash-lfm-btn${lfmLoved ? ' is-loved' : ''}`}
              data-tooltip={lfmLoved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}>
              <LastfmIcon size={18} />
            </button>
          )}
          <button className="np-dash-icon-btn"
            onClick={onOpenLyrics}
            data-tooltip={t('player.lyrics')}
            style={{ color: activeLyricsTab ? 'var(--accent)' : undefined }}>
            <MicVocal size={18} />
          </button>
          {rating && renderStars(rating)}
        </div>

        {(playCount != null && playCount > 0) && (
          <div className="np-dash-hero-stat">
            <Headphones size={13} />
            <span>{t('nowPlaying.playsCount', { count: playCount, defaultValue: '{{count}} plays' })}</span>
          </div>
        )}

        {(lfmTrack || lfmArtist) && (
          <div className="np-dash-hero-lfm">
            <div className="np-dash-hero-lfm-heading">
              <span className="np-dash-hero-lfm-badge">Last.fm</span>
            </div>
            {lfmTrack && (
              <div className="np-dash-hero-lfm-row">
                <span className="np-dash-hero-lfm-scope">{t('nowPlaying.thisTrack', 'This track')}</span>
                <span className="np-dash-hero-lfm-sep">—</span>
                <span>{t('nowPlaying.listenersN', { n: lfmTrack.listeners.toLocaleString(), defaultValue: '{{n}} listeners' })}</span>
                <span className="np-dash-hero-lfm-dot">·</span>
                <span>{t('nowPlaying.scrobblesN', { n: lfmTrack.playcount.toLocaleString(), defaultValue: '{{n}} scrobbles' })}</span>
                {lfmTrack.userPlaycount != null && (
                  <>
                    <span className="np-dash-hero-lfm-dot">·</span>
                    <span className="np-dash-hero-lfm-you">
                      {t('nowPlaying.playsByYouN', { n: lfmTrack.userPlaycount.toLocaleString(), defaultValue: 'played {{n}}× by you' })}
                    </span>
                  </>
                )}
              </div>
            )}
            {lfmArtist && (
              <div className="np-dash-hero-lfm-row">
                <span className="np-dash-hero-lfm-scope">{t('nowPlaying.thisArtist', 'This artist')}</span>
                <span className="np-dash-hero-lfm-sep">—</span>
                <span>{t('nowPlaying.listenersN', { n: lfmArtist.listeners.toLocaleString(), defaultValue: '{{n}} listeners' })}</span>
                <span className="np-dash-hero-lfm-dot">·</span>
                <span>{t('nowPlaying.scrobblesN', { n: lfmArtist.playcount.toLocaleString(), defaultValue: '{{n}} scrobbles' })}</span>
                {lfmArtist.userPlaycount != null && (
                  <>
                    <span className="np-dash-hero-lfm-dot">·</span>
                    <span className="np-dash-hero-lfm-you">
                      {t('nowPlaying.playsByYouN', { n: lfmArtist.userPlaycount.toLocaleString(), defaultValue: 'played {{n}}× by you' })}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

interface ArtistCardProps {
  artistName: string;
  artistId?: string;
  artistInfo: SubsonicArtistInfo | null;
  onNavigate: (path: string) => void;
}

const ArtistCard = memo(function ArtistCard({ artistName, artistId, artistInfo, onNavigate }: ArtistCardProps) {
  const { t } = useTranslation();
  const [bioExpanded, setBioExpanded] = useState(false);
  const [bioOverflows, setBioOverflows] = useState(false);
  const bioRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setBioExpanded(false); }, [artistId]);

  const bioHtml = useMemo(() => artistInfo?.biography ? sanitizeHtml(artistInfo.biography) : '', [artistInfo?.biography]);

  useLayoutEffect(() => {
    const el = bioRef.current;
    if (!el) { setBioOverflows(false); return; }
    setBioOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [bioHtml]);

  const similar = artistInfo?.similarArtist ?? [];
  const rawLarge = artistInfo?.largeImageUrl;
  const rawMed   = artistInfo?.mediumImageUrl;
  const heroImage = isRealArtistImage(rawLarge)
    ? rawLarge!
    : isRealArtistImage(rawMed) ? rawMed! : '';
  const heroCacheKey = artistId ? `artistInfo:${artistId}:hero` : '';

  if (!bioHtml && similar.length === 0 && !heroImage) return null;

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">{t('nowPlaying.aboutArtist')}</h3>
        {artistId && (
          <button className="np-card-link" onClick={() => onNavigate(`/artist/${artistId}`)}>
            {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
          </button>
        )}
      </div>

      <div className="np-dash-artist-body">
        {heroImage && heroCacheKey && (
          <CachedImage
            src={heroImage}
            cacheKey={heroCacheKey}
            alt={artistName}
            className="np-dash-artist-image"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        <div className="np-dash-artist-text">
          <div className="np-dash-artist-name">{artistName}</div>
          {bioHtml && (
            <>
              <div
                ref={bioRef}
                className={`np-bio-text${bioExpanded ? ' expanded' : ''}`}
                dangerouslySetInnerHTML={{ __html: bioHtml }}
              />
              {(bioOverflows || bioExpanded) && (
                <button className="np-bio-toggle" onClick={() => setBioExpanded(v => !v)}>
                  {bioExpanded ? t('nowPlayingInfo.bioReadLess', 'Show less') : t('nowPlayingInfo.bioReadMore', 'Read more')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {similar.length > 0 && (
        <div className="np-dash-similar">
          <div className="np-dash-chip-row">
            {similar.slice(0, 12).map(a => (
              <span key={a.id} className="np-chip"
                onClick={() => a.id && onNavigate(`/artist/${a.id}`)}
                data-tooltip={t('nowPlaying.goToArtist')}>
                {a.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

interface AlbumCardProps {
  album: SubsonicAlbum | null;
  songs: SubsonicSong[];
  currentTrackId: string;
  albumName: string;
  albumId?: string;
  albumYear?: number;
  onNavigate: (path: string) => void;
}

const ALBUM_TRACK_LIMIT = 10;

const AlbumCard = memo(function AlbumCard({ album, songs, currentTrackId, albumName, albumId, albumYear, onNavigate }: AlbumCardProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [albumId]);

  if (songs.length === 0) return null;

  const totalDur = songs.reduce((sum, s) => sum + (s.duration || 0), 0);
  const currentIdx = songs.findIndex(s => s.id === currentTrackId);
  const position = currentIdx >= 0 ? `${currentIdx + 1} / ${songs.length}` : `${songs.length}`;

  // Sliding window anchored at the current track: when the running track sits
  // beyond position N, show the N tracks ending with (and including) it.
  // "Show all" expands to the full list.
  let visibleSongs: SubsonicSong[];
  if (showAll) {
    visibleSongs = songs;
  } else if (currentIdx < ALBUM_TRACK_LIMIT) {
    visibleSongs = songs.slice(0, ALBUM_TRACK_LIMIT);
  } else {
    const end = currentIdx + 1;
    visibleSongs = songs.slice(end - ALBUM_TRACK_LIMIT, end);
  }
  const hiddenCount = Math.max(0, songs.length - visibleSongs.length);

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <Disc3 size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlaying.fromAlbum')}
        </h3>
        {albumId && (
          <button className="np-card-link" onClick={() => onNavigate(`/album/${albumId}`)}>
            {t('nowPlaying.viewAlbum')} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="np-dash-album-meta">
        <span className="np-dash-album-name">{albumName}</span>
        <span className="np-dash-album-stats">
          {albumYear && <span>{albumYear}</span>}
          {albumYear && <span className="np-sep">·</span>}
          <span>{t('nowPlaying.trackPosition', { pos: position, defaultValue: 'Track {{pos}}' })}</span>
          <span className="np-sep">·</span>
          <span>{formatTotalDuration(totalDur)}</span>
          {album?.playCount != null && album.playCount > 0 && (
            <><span className="np-sep">·</span><span>{t('nowPlaying.playsCount', { count: album.playCount, defaultValue: '{{count}} plays' })}</span></>
          )}
        </span>
      </div>
      <div className="np-album-tracklist">
        {visibleSongs.map(track => {
          const isActive = track.id === currentTrackId;
          return (
            <div key={track.id}
              className={`np-album-track${isActive ? ' active' : ''}`}>
              <span className="np-album-track-num">
                {isActive
                  ? <Star size={10} fill="var(--accent)" color="var(--accent)" />
                  : track.track ?? '—'}
              </span>
              <span className="np-album-track-title truncate">{track.title}</span>
              <span className="np-album-track-dur">{formatTime(track.duration)}</span>
            </div>
          );
        })}
      </div>
      {songs.length > ALBUM_TRACK_LIMIT && (
        <button className="np-dash-tracklist-more" onClick={() => setShowAll(v => !v)}>
          {showAll
            ? t('nowPlaying.showLessTracks', 'Show less')
            : t('nowPlaying.showMoreTracks', { defaultValue: 'Show {{count}} more', count: hiddenCount })}
        </button>
      )}
    </div>
  );
});

interface TopSongsCardProps {
  artistName: string;
  artistId?: string;
  songs: SubsonicSong[];
  currentTrackId: string;
  onNavigate: (path: string) => void;
  onPlay: (song: SubsonicSong) => void;
}

const TopSongsCard = memo(function TopSongsCard({ artistName, artistId, songs, currentTrackId, onNavigate, onPlay }: TopSongsCardProps) {
  const { t } = useTranslation();
  const top = songs.slice(0, 8);
  if (top.length === 0) return null;

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <TrendingUp size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlaying.topSongs', { defaultValue: 'Most played by this artist' })}
        </h3>
        {artistId && (
          <button className="np-card-link" onClick={() => onNavigate(`/artist/${artistId}`)}>
            {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="np-dash-top-list">
        {top.map((s, idx) => {
          const isActive = s.id === currentTrackId;
          return (
            <div key={s.id}
              className={`np-dash-top-row${isActive ? ' active' : ''}`}
              onClick={() => onPlay(s)}
              data-tooltip={t('contextMenu.playNow')}>
              <span className="np-dash-top-rank">{idx + 1}</span>
              <div className="np-dash-top-body">
                <span className="np-dash-top-title truncate">{s.title}</span>
                {s.album && <span className="np-dash-top-sub truncate">{s.album}</span>}
              </div>
              <span className="np-dash-top-dur">{formatTime(s.duration)}</span>
              <Play size={14} className="np-dash-top-play" />
            </div>
          );
        })}
      </div>
      <div className="np-dash-top-credit">{t('nowPlaying.topSongsCredit', { name: artistName, defaultValue: 'Top tracks from {{name}}' })}</div>
    </div>
  );
});

interface CreditsCardProps { rows: ContributorRow[]; }

const CreditsCard = memo(function CreditsCard({ rows }: CreditsCardProps) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">{t('nowPlayingInfo.songInfo', 'Song info')}</h3>
      </div>
      <ul className="np-info-credits">
        {rows.map(row => (
          <li key={row.role} className="np-info-credit-row">
            <span className="np-info-credit-role">{t(`nowPlayingInfo.role.${row.role}`, row.role)}</span>
            <span className="np-info-credit-names">{row.names.join(', ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

interface TourCardProps {
  artistName: string;
  enabled: boolean;
  loading: boolean;
  events: BandsintownEvent[];
  onEnable: () => void;
}

const TourCard = memo(function TourCard({ artistName, enabled, loading, events, onEnable }: TourCardProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [artistName]);
  const TOUR_LIMIT = 5;
  const visible = showAll ? events : events.slice(0, TOUR_LIMIT);
  const hidden = Math.max(0, events.length - visible.length);

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <Calendar size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlayingInfo.onTour', 'On tour')}
        </h3>
      </div>

      {!enabled ? (
        <div className="np-info-bandsintown-prompt">
          <div className="np-info-bandsintown-prompt-title">
            <span>{t('nowPlayingInfo.enableBandsintownPrompt', 'See upcoming tour dates?')}</span>
            <span className="np-info-bandsintown-prompt-info"
              data-tooltip={t('nowPlayingInfo.enableBandsintownPrivacy', 'When enabled, the current artist\'s name is sent to the Bandsintown API to fetch tour dates. No personal account information leaves your device.')}
              data-tooltip-pos="bottom"
              data-tooltip-wrap="true"
              tabIndex={0}>
              <Info size={13} />
            </span>
          </div>
          <div className="np-info-bandsintown-prompt-desc">
            {t('nowPlayingInfo.enableBandsintownPromptDesc', 'Optional. Loads concerts for the current artist via Bandsintown.')}
          </div>
          <button className="np-info-bandsintown-prompt-btn" onClick={onEnable}>
            {t('nowPlayingInfo.enableBandsintownAction', 'Enable')}
          </button>
        </div>
      ) : (
        <>
          {loading && events.length === 0 && (
            <div className="np-info-tour-empty">{t('nowPlayingInfo.tourLoading', 'Loading…')}</div>
          )}
          {!loading && events.length === 0 && (
            <div className="np-info-tour-empty">{t('nowPlayingInfo.noTourEvents', 'No upcoming shows')}</div>
          )}
          {visible.length > 0 && (
            <ul className="np-info-tour">
              {visible.map((ev, idx) => {
                const parts = isoToParts(ev.datetime);
                const place = [ev.venueCity, ev.venueRegion, ev.venueCountry].filter(Boolean).join(', ');
                return (
                  <li key={`${ev.datetime}-${ev.venueName}-${idx}`}
                    className="np-info-tour-item"
                    onClick={() => ev.url && shellOpen(ev.url).catch(() => {})}
                    role={ev.url ? 'button' : undefined}
                    tabIndex={ev.url ? 0 : undefined}>
                    {parts && (
                      <div className="np-info-tour-date">
                        <div className="np-info-tour-date-month">{parts.month}</div>
                        <div className="np-info-tour-date-day">{parts.day}</div>
                      </div>
                    )}
                    <div className="np-info-tour-meta">
                      <div className="np-info-tour-venue">{ev.venueName || place}</div>
                      <div className="np-info-tour-place">
                        {parts && <span className="np-info-tour-when">{parts.weekday}, {parts.time}</span>}
                        {parts && place && <span className="np-info-tour-sep"> • </span>}
                        <span>{place}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {(hidden > 0 || (showAll && events.length > TOUR_LIMIT)) && (
            <button className="np-info-tour-more" onClick={() => setShowAll(v => !v)}>
              {showAll
                ? t('nowPlayingInfo.showLessTours', 'Show less')
                : t('nowPlayingInfo.showMoreTours', { defaultValue: 'Show {{count}} more', count: hidden })}
            </button>
          )}
          <div className="np-info-tour-credit">{t('nowPlayingInfo.poweredByBandsintown', 'Tour data via Bandsintown')}</div>
        </>
      )}
    </div>
  );
});

// ─── Radio view (unchanged from previous implementation) ──────────────────────

// ─── Discography card ────────────────────────────────────────────────────────

interface DiscographyCardProps {
  artistId?: string;
  albums: SubsonicAlbum[];
  currentAlbumId?: string;
  onNavigate: (path: string) => void;
}

const DISC_GRID_COLS = 10;
const DISC_INITIAL_ROWS = 2;
const DISC_INITIAL = DISC_GRID_COLS * DISC_INITIAL_ROWS;

const DiscographyCard = memo(function DiscographyCard({ artistId, albums, currentAlbumId, onNavigate }: DiscographyCardProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [artistId]);

  if (albums.length === 0) return null;

  // Chronological sort, newest first. Always clamp to initial rows; expansion is explicit.
  const ordered = [...albums].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  const visible = showAll ? ordered : ordered.slice(0, DISC_INITIAL);
  const hiddenCount = Math.max(0, ordered.length - visible.length);

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <Disc3 size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlaying.discography', 'Discography')}
        </h3>
        {artistId && (
          <button className="np-card-link" onClick={() => onNavigate(`/artist/${artistId}`)}>
            {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="np-dash-disc-grid">
        {visible.map(a => {
          const isActive = a.id === currentAlbumId;
          const fetchUrl = a.coverArt ? buildCoverArtUrl(a.coverArt, 200) : '';
          const key      = a.coverArt ? coverArtCacheKey(a.coverArt, 200) : '';
          return (
            <div key={a.id}
              className={`np-dash-disc-tile${isActive ? ' active' : ''}`}
              onClick={() => onNavigate(`/album/${a.id}`)}
              data-tooltip={`${a.name}${a.year ? ` · ${a.year}` : ''}`}>
              <div className="np-dash-disc-cover">
                {fetchUrl && key
                  ? <CachedImage src={fetchUrl} cacheKey={key} alt={a.name} className="np-dash-disc-img" />
                  : <div className="np-dash-disc-fallback"><Music size={18} /></div>}
              </div>
            </div>
          );
        })}
      </div>
      {ordered.length > DISC_INITIAL && (
        <button className="np-dash-tracklist-more" onClick={() => setShowAll(v => !v)}>
          {showAll
            ? t('nowPlaying.showLessTracks', 'Show less')
            : t('nowPlaying.showMoreTracks', { defaultValue: 'Show {{count}} more', count: hiddenCount })}
        </button>
      )}
    </div>
  );
});

type NonNullStoreField<K extends keyof ReturnType<typeof usePlayerStore.getState>> =
  NonNullable<ReturnType<typeof usePlayerStore.getState>[K]>;

interface RadioViewProps {
  radioMeta: ReturnType<typeof useRadioMetadata>;
  currentRadio: NonNullStoreField<'currentRadio'>;
  resolvedCover: string;
}

const RadioView = memo(function RadioView({ radioMeta, currentRadio, resolvedCover }: RadioViewProps) {
  const { t } = useTranslation();
  return (
    <div className="np-radio-section">
      <div className="np-hero-card">
        <div className="np-hero-left">
          <div className="np-hero-info">
            <div className="np-title" style={{ color: 'var(--accent)' }}>{currentRadio.name}</div>
            {radioMeta.currentTitle && (
              <div className="np-artist-album">
                {radioMeta.currentArtist && (<><span className="np-link">{radioMeta.currentArtist}</span><span className="np-sep">·</span></>)}
                <span>{radioMeta.currentTitle}</span>
                {radioMeta.currentAlbum && (<><span className="np-sep">·</span><span style={{ opacity: 0.6 }}>{radioMeta.currentAlbum}</span></>)}
              </div>
            )}
            <div className="np-tech-row">
              <span className="np-badge np-badge-live"><Radio size={10} style={{ marginRight: 3 }} />{t('radio.live')}</span>
              {radioMeta.source === 'azuracast' && <span className="np-badge np-badge-azuracast">AzuraCast</span>}
              {radioMeta.listeners != null && (
                <span className="np-badge"><Users size={10} style={{ marginRight: 3 }} />{t('radio.listenerCount', { count: radioMeta.listeners })}</span>
              )}
            </div>
            {radioMeta.source === 'azuracast' && radioMeta.elapsed != null && radioMeta.duration != null && radioMeta.duration > 0 && (
              <div className="np-radio-progress-wrap">
                <span className="np-radio-time">{formatTime(radioMeta.elapsed)}</span>
                <div className="np-radio-progress-bar">
                  <div className="np-radio-progress-fill" style={{ width: `${Math.min(100, (radioMeta.elapsed / radioMeta.duration) * 100)}%` }} />
                </div>
                <span className="np-radio-time">{formatTime(radioMeta.duration)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="np-hero-cover-wrap">
          {resolvedCover
            ? <img src={resolvedCover} alt={currentRadio.name} className="np-cover" />
            : radioMeta.currentArt
              ? <img src={radioMeta.currentArt} alt="" className="np-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              : <div className="np-cover np-cover-fallback"><Cast size={52} /></div>}
        </div>
        <div style={{ flex: 1 }} />
      </div>

      {radioMeta.nextSong && (
        <div className="np-info-card">
          <div className="np-card-header">
            <h3 className="np-card-title"><SkipForward size={13} style={{ marginRight: 5 }} />{t('radio.upNext')}</h3>
          </div>
          <div className="np-radio-next-track">
            {radioMeta.nextSong.art && (
              <img src={radioMeta.nextSong.art} alt="" className="np-radio-track-art"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            )}
            <div className="np-radio-track-info">
              <span className="np-radio-track-title">{radioMeta.nextSong.title}</span>
              {radioMeta.nextSong.artist && <span className="np-radio-track-artist">{radioMeta.nextSong.artist}</span>}
            </div>
          </div>
        </div>
      )}

      {radioMeta.history.length > 0 && (
        <div className="np-info-card">
          <div className="np-card-header">
            <h3 className="np-card-title"><Clock size={13} style={{ marginRight: 5 }} />{t('radio.recentlyPlayed')}</h3>
          </div>
          <div className="np-album-tracklist">
            {radioMeta.history.map((item, idx) => (
              <div key={idx} className="np-album-track">
                {item.song.art && (
                  <img src={item.song.art} alt="" className="np-radio-track-art np-radio-track-art--sm"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                )}
                <span className="np-album-track-title truncate">
                  {item.song.artist ? `${item.song.artist} — ${item.song.title}` : item.song.title}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NowPlaying() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const stableNavigate = useCallback((path: string) => navigate(path), [navigate]);

  const currentTrack            = usePlayerStore(s => s.currentTrack);
  const currentRadio            = usePlayerStore(s => s.currentRadio);
  const userRatingOverrides     = usePlayerStore(s => s.userRatingOverrides);
  const showLyrics              = useLyricsStore(s => s.showLyrics);
  const activeTab               = useLyricsStore(s => s.activeTab);
  const isQueueVisible          = usePlayerStore(s => s.isQueueVisible);
  const toggleQueue             = usePlayerStore(s => s.toggleQueue);
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(s.activeServerId && s.audiomuseNavidromeByServer[s.activeServerId]),
  );
  const enableBandsintown    = useAuthStore(s => s.enableBandsintown);
  const setEnableBandsintown = useAuthStore(s => s.setEnableBandsintown);
  const lastfmUsername       = useAuthStore(s => s.lastfmUsername);
  const lastfmSessionKey     = useAuthStore(s => s.lastfmSessionKey);
  const playTrackFn          = usePlayerStore(s => s.playTrack);

  const radioMeta = useRadioMetadata(currentRadio ?? null);

  const songId    = currentTrack?.id;
  const artistId  = currentTrack?.artistId;
  const albumId   = currentTrack?.albumId;
  const artistName = currentTrack?.artist ?? '';

  // Entity state, seeded from TTL cache so same-artist song switches are instant
  const [songMeta,   setSongMeta]   = useState<SubsonicSong | null>(() => songId ? songMetaCache.get(songId) ?? null : null);
  const [artistInfo, setArtistInfo] = useState<SubsonicArtistInfo | null>(() => artistId ? artistInfoCache.get(artistId) ?? null : null);
  const [albumData,  setAlbumData]  = useState<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>(() => albumId ? albumCache.get(albumId) ?? null : null);
  const [topSongs,   setTopSongs]   = useState<SubsonicSong[]>(() => artistName ? topSongsCache.get(artistName) ?? [] : []);
  const [tourEvents, setTourEvents] = useState<BandsintownEvent[]>(() => artistName ? tourCache.get(artistName) ?? [] : []);
  const [tourLoading, setTourLoading] = useState(false);
  const [discography, setDiscography] = useState<SubsonicAlbum[]>(() => artistId ? discographyCache.get(artistId) ?? [] : []);
  const [lfmTrack,   setLfmTrack]   = useState<LastfmTrackInfo | null>(null);
  const [lfmArtist,  setLfmArtist]  = useState<LastfmArtistStats | null>(null);

  // Fetch batch per entity change (not per song switch — same-artist songs share artist/top/tour fetches)
  useEffect(() => {
    if (!songId) { setSongMeta(null); return; }
    const cached = songMetaCache.get(songId);
    if (cached !== undefined) { setSongMeta(cached); return; }
    let cancelled = false;
    getSong(songId)
      .then(v => { if (!cancelled) { songMetaCache.set(songId, v ?? null); setSongMeta(v ?? null); } })
      .catch(() => { if (!cancelled) { songMetaCache.set(songId, null); setSongMeta(null); } });
    return () => { cancelled = true; };
  }, [songId]);

  useEffect(() => {
    if (!artistId) { setArtistInfo(null); return; }
    const cached = artistInfoCache.get(artistId);
    if (cached !== undefined) { setArtistInfo(cached); return; }
    let cancelled = false;
    getArtistInfo(artistId, { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined })
      .then(v => { if (!cancelled) { artistInfoCache.set(artistId, v ?? null); setArtistInfo(v ?? null); } })
      .catch(() => { if (!cancelled) { artistInfoCache.set(artistId, null); setArtistInfo(null); } });
    return () => { cancelled = true; };
  }, [artistId, audiomuseNavidromeEnabled]);

  useEffect(() => {
    if (!albumId) { setAlbumData(null); return; }
    const cached = albumCache.get(albumId);
    if (cached !== undefined) { setAlbumData(cached); return; }
    let cancelled = false;
    getAlbum(albumId)
      .then(v => { if (!cancelled) { albumCache.set(albumId, v); setAlbumData(v); } })
      .catch(() => { if (!cancelled) { albumCache.set(albumId, null); setAlbumData(null); } });
    return () => { cancelled = true; };
  }, [albumId]);

  useEffect(() => {
    if (!artistName) { setTopSongs([]); return; }
    const cached = topSongsCache.get(artistName);
    if (cached !== undefined) { setTopSongs(cached); return; }
    let cancelled = false;
    getTopSongs(artistName)
      .then(v => { if (!cancelled) { topSongsCache.set(artistName, v); setTopSongs(v); } })
      .catch(() => { if (!cancelled) { topSongsCache.set(artistName, []); setTopSongs([]); } });
    return () => { cancelled = true; };
  }, [artistName]);

  useEffect(() => {
    if (!enableBandsintown || !artistName) { setTourEvents([]); return; }
    const cached = tourCache.get(artistName);
    if (cached !== undefined) { setTourEvents(cached); setTourLoading(false); return; }
    let cancelled = false;
    setTourLoading(true);
    fetchBandsintownEvents(artistName)
      .then(v => { if (!cancelled) { tourCache.set(artistName, v); setTourEvents(v); } })
      .finally(() => { if (!cancelled) setTourLoading(false); });
    return () => { cancelled = true; };
  }, [enableBandsintown, artistName]);

  // Discography via getArtist
  useEffect(() => {
    if (!artistId) { setDiscography([]); return; }
    const cached = discographyCache.get(artistId);
    if (cached !== undefined) { setDiscography(cached); return; }
    let cancelled = false;
    getArtist(artistId)
      .then(v => { if (!cancelled) { discographyCache.set(artistId, v.albums); setDiscography(v.albums); } })
      .catch(() => { if (!cancelled) { discographyCache.set(artistId, []); setDiscography([]); } });
    return () => { cancelled = true; };
  }, [artistId]);

  // Last.fm track info (per-track)
  const lfmTrackKey = currentTrack ? `${currentTrack.artist} ${currentTrack.title} ${lastfmUsername}` : '';
  useEffect(() => {
    if (!lastfmIsConfigured() || !currentTrack) { setLfmTrack(null); return; }
    const cached = lfmTrackCache.get(lfmTrackKey);
    if (cached !== undefined) { setLfmTrack(cached); return; }
    let cancelled = false;
    lastfmGetTrackInfo(currentTrack.artist, currentTrack.title, lastfmUsername || undefined)
      .then(v => { if (!cancelled) { lfmTrackCache.set(lfmTrackKey, v); setLfmTrack(v); } })
      .catch(() => { if (!cancelled) { lfmTrackCache.set(lfmTrackKey, null); setLfmTrack(null); } });
    return () => { cancelled = true; };
  }, [lfmTrackKey, currentTrack, lastfmUsername]);

  // Last.fm artist stats (per-artist — shared across same-artist tracks)
  const lfmArtistKey = artistName ? `${artistName} ${lastfmUsername}` : '';
  useEffect(() => {
    if (!lastfmIsConfigured() || !artistName) { setLfmArtist(null); return; }
    const cached = lfmArtistCache.get(lfmArtistKey);
    if (cached !== undefined) { setLfmArtist(cached); return; }
    let cancelled = false;
    lastfmGetArtistStats(artistName, lastfmUsername || undefined)
      .then(v => { if (!cancelled) { lfmArtistCache.set(lfmArtistKey, v); setLfmArtist(v); } })
      .catch(() => { if (!cancelled) { lfmArtistCache.set(lfmArtistKey, null); setLfmArtist(null); } });
    return () => { cancelled = true; };
  }, [lfmArtistKey, artistName, lastfmUsername]);

  // Star
  const [starred, setStarred] = useState(false);
  useEffect(() => { setStarred(!!songMeta?.starred); }, [songMeta]);
  const toggleStar = useCallback(async () => {
    if (!currentTrack) return;
    if (starred) { await unstar(currentTrack.id, 'song'); setStarred(false); }
    else         { await star(currentTrack.id,   'song'); setStarred(true);  }
  }, [currentTrack, starred]);

  // Last.fm love (seeded from track.getInfo, toggle via love/unlove)
  const lfmLoveEnabled = Boolean(lastfmUsername && lastfmSessionKey);
  const [lfmLoved, setLfmLoved] = useState(false);
  useEffect(() => { setLfmLoved(!!lfmTrack?.userLoved); }, [lfmTrack]);
  const toggleLfmLove = useCallback(async () => {
    if (!currentTrack || !lfmLoveEnabled) return;
    const track = { title: currentTrack.title, artist: currentTrack.artist };
    if (lfmLoved) { await lastfmUnloveTrack(track, lastfmSessionKey); setLfmLoved(false); }
    else          { await lastfmLoveTrack  (track, lastfmSessionKey); setLfmLoved(true);  }
  }, [currentTrack, lfmLoved, lfmLoveEnabled, lastfmSessionKey]);

  const openLyrics = useCallback(() => {
    if (!isQueueVisible) toggleQueue();
    showLyrics();
  }, [isQueueVisible, toggleQueue, showLyrics]);

  // Cover
  const coverFetchUrl   = currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 800) : '';
  const coverKey        = currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 800) : '';
  const resolvedCover   = useCachedUrl(coverFetchUrl, coverKey);

  const radioCoverFetchUrl = currentRadio?.coverArt ? buildCoverArtUrl(`ra-${currentRadio.id}`, 800) : '';
  const radioCoverKey      = currentRadio?.coverArt ? coverArtCacheKey(`ra-${currentRadio.id}`, 800) : '';
  const resolvedRadioCover = useCachedUrl(radioCoverFetchUrl, radioCoverKey);

  const contributorRows = useMemo(
    () => buildContributorRows(songMeta, artistName),
    [songMeta, artistName],
  );

  // Merge Subsonic artistInfo with Last.fm fallback: if Subsonic has no bio,
  // use Last.fm's artist bio so the card doesn't show up empty.
  const effectiveArtistInfo = useMemo<SubsonicArtistInfo | null>(() => {
    if (!artistInfo && !lfmArtist?.bio) return null;
    if (artistInfo?.biography) return artistInfo;
    if (!lfmArtist?.bio) return artistInfo;
    return {
      ...(artistInfo ?? {}),
      biography: lfmArtist.bio,
    };
  }, [artistInfo, lfmArtist]);

  const handleEnableBandsintown = useCallback(() => setEnableBandsintown(true), [setEnableBandsintown]);

  const handlePlayTopSong = useCallback((song: SubsonicSong) => {
    if (topSongs.length === 0) return;
    const queue = topSongs.map(songToTrack);
    const hit = queue.find(q => q.id === song.id);
    if (hit) playTrackFn(hit, queue);
  }, [topSongs, playTrackFn]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="np-page">
      <div className="np-main">
        {currentRadio && !currentTrack ? (
          <RadioView radioMeta={radioMeta} currentRadio={currentRadio} resolvedCover={resolvedRadioCover} />
        ) : currentTrack ? (
          <div className="np-dash">
            <Hero
              track={{
                id: currentTrack.id,
                title: currentTrack.title,
                artist: currentTrack.artist,
                album: currentTrack.album,
                year: currentTrack.year,
                duration: currentTrack.duration,
                suffix: currentTrack.suffix,
                bitRate: currentTrack.bitRate,
                samplingRate: songMeta?.samplingRate,
                bitDepth: songMeta?.bitDepth,
                artistId: currentTrack.artistId,
                albumId: currentTrack.albumId,
                userRating: currentTrack.userRating,
              }}
              genre={songMeta?.genre ?? undefined}
              playCount={(songMeta as (SubsonicSong & { playCount?: number }) | null)?.playCount}
              userRatingOverride={userRatingOverrides[currentTrack.id]}
              lfmTrack={lfmTrack}
              lfmArtist={lfmArtist}
              starred={starred}
              lfmLoved={lfmLoved}
              lfmLoveEnabled={lfmLoveEnabled}
              activeLyricsTab={activeTab === 'lyrics' && isQueueVisible}
              coverUrl={resolvedCover}
              onNavigate={stableNavigate}
              onToggleStar={toggleStar}
              onToggleLfmLove={toggleLfmLove}
              onOpenLyrics={openLyrics}
            />

            <div className="np-dash-grid">
              <div className="np-dash-col">
                <AlbumCard
                  album={albumData?.album ?? null}
                  songs={albumData?.songs ?? []}
                  currentTrackId={currentTrack.id}
                  albumName={currentTrack.album}
                  albumId={albumId}
                  albumYear={currentTrack.year}
                  onNavigate={stableNavigate}
                />
                <TopSongsCard
                  artistName={artistName}
                  artistId={artistId}
                  songs={topSongs}
                  currentTrackId={currentTrack.id}
                  onNavigate={stableNavigate}
                  onPlay={handlePlayTopSong}
                />
                <CreditsCard rows={contributorRows} />
              </div>
              <div className="np-dash-col">
                <ArtistCard
                  artistName={artistName}
                  artistId={artistId}
                  artistInfo={effectiveArtistInfo}
                  onNavigate={stableNavigate}
                />
                <DiscographyCard
                  artistId={artistId}
                  albums={discography}
                  currentAlbumId={albumId}
                  onNavigate={stableNavigate}
                />
                <TourCard
                  artistName={artistName}
                  enabled={enableBandsintown}
                  loading={tourLoading}
                  events={tourEvents}
                  onEnable={handleEnableBandsintown}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="np-empty-state">
            <Music size={48} style={{ opacity: 0.3 }} />
            <p>{t('nowPlaying.nothingPlaying')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
