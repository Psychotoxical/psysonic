import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  SkipBack, SkipForward, Square, Repeat, Repeat1, Heart,
  Shuffle, ListMusic, ChevronDown, Star, MicVocal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { queueSongStar, queueSongRating } from '@/features/playback/store/pendingStarSync';
import { useAlbumCoverRef, useArtistCoverRef } from '@/cover/useLibraryCoverRef';
import { usePlaybackCoverArt } from '@/cover/usePlaybackCoverArt';
import { useCachedUrl } from '@/ui/CachedImage';
import { useArtistFanart } from '@/cover/useArtistFanart';
import { backdropFromConfig } from '@/cover/artistBackdrop';
import { useThemeStore } from '@/store/themeStore';
import { useFsIdleFade } from '@/features/fullscreenPlayer/hooks/useFsIdleFade';
import { useQueueTrackAt } from '@/features/queue';
import { WaveformSeek } from '@/features/waveform';
import { FsQueueModal } from '@/features/fullscreenPlayer/components/FsQueueModal';
import { FsLyricsApple } from '@/features/fullscreenPlayer/components/FsLyricsApple';
import { FsPlayBtn } from '@/features/fullscreenPlayer/components/FsPlayBtn';
import { FsClock } from '@/features/fullscreenPlayer/components/FsClock';
import { FsTimeReadout } from '@/features/fullscreenPlayer/components/FsTimeReadout';

interface Props {
  onClose: () => void;
}

/**
 * Fullscreen background image that eases in once its pixels are loaded, so a
 * new background fades up from the empty backdrop instead of hard-cutting.
 *
 * Mount it with `key={url}` so every source gets a fresh element (and a fresh
 * `loaded=false`). Both load paths are covered: `onLoad` for a network/disk
 * fetch, and the `ref`'s `complete` check for an already-cached image whose
 * `load` event can fire before React attaches the handler (e.g. skipping back
 * to a recently shown artist) — without it the background would stay black.
 */
function FsBackground({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);
  if (!url) return <div className="fsp-bg fsp-bg--empty" aria-hidden="true" />;
  return (
    <img
      className={`fsp-bg${loaded ? ' is-loaded' : ''}`}
      src={url}
      onLoad={() => setLoaded(true)}
      ref={(el) => {
        if (el?.complete) setLoaded(true);
      }}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export default function FullscreenPlayerStatic({ onClose }: Props) {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const repeatMode = usePlayerStore(s => s.repeatMode);
  const next = usePlayerStore(s => s.next);
  const previous = usePlayerStore(s => s.previous);
  const stop = usePlayerStore(s => s.stop);
  const toggleRepeat = usePlayerStore(s => s.toggleRepeat);
  const shuffleUpcomingQueue = usePlayerStore(s => s.shuffleUpcomingQueue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const queueLen = usePlayerStore(s => s.queueItems.length);

  // Derive the boolean inside the selector so the cluster only re-renders when
  // the star actually flips, not on any unrelated track's star change.
  const isStarred = usePlayerStore(s => {
    const track = s.currentTrack;
    if (!track) return false;
    return track.id in s.starredOverrides ? s.starredOverrides[track.id] : !!track.starred;
  });
  const toggleStar = useCallback(() => {
    if (!currentTrack) return;
    queueSongStar(currentTrack.id, !isStarred, currentTrack.serverId);
  }, [currentTrack, isStarred]);

  const duration = currentTrack?.duration ?? 0;

  // Album-keyed cover ref so the cover stays stable across track changes within
  // the same album. A per-track ref re-keys on `track.coverArt` (Navidrome hands
  // out `mf-<trackId>` per track), which the distinct-disc heuristic mistakes for
  // per-disc art and reloads the cover on every song change. Keying on albumId
  // sidesteps that — same lesson as the artist portrait keying on artistId.
  // `usePlaybackCoverArt` still re-scopes it to the playback server.
  const playbackCoverRef =
    useAlbumCoverRef(currentTrack?.albumId, undefined, undefined, { libraryResolve: false }) ?? undefined;
  // One high-res cover (cucadmuh's fullRes 2000px path) feeds the foreground
  // thumbnail — crisp instead of the old low-res tier. It is no longer a
  // background source (see below).
  const cover = usePlaybackCoverArt(playbackCoverRef, 2000, { fullRes: true });
  // `true` = show the raw URL immediately while the blob resolves (same as FsArt).
  const coverUrl = useCachedUrl(cover.src, cover.cacheKey, true);
  const thumbUrl = coverUrl;
  // Background (§28). The album cover is deliberately NOT a background source —
  // it only ever feeds the foreground thumbnail. The user-configurable source
  // list (fanart / Navidrome artist image, no banner) drives the rest: with the
  // scraper on and fanart first, the fanart.tv 16:9 image is the background and
  // while it resolves the background stays empty (no album/artist flash), then
  // falls back per the list; with the scraper off the fanart source reports a
  // non-pending miss, so the chain steps straight to the Navidrome artist image.
  const fsBackdropCfg = useThemeStore((s) => s.backdrops.fullscreenPlayer);
  const fanart = useArtistFanart(currentTrack?.artistId, {
    artistName: currentTrack?.artist,
    albumTitle: currentTrack?.album,
  });
  const artistCoverRef =
    useArtistCoverRef(currentTrack?.artistId, undefined, undefined, { libraryResolve: false }) ??
    undefined;
  const artistImage = usePlaybackCoverArt(artistCoverRef, 2000, { fullRes: true });
  const artistImgUrl = useCachedUrl(artistImage.src, artistImage.cacheKey, true);
  const fsBackdrop = backdropFromConfig(fsBackdropCfg.sources, { fanart, navidrome: artistImgUrl });
  const bgUrl = fsBackdropCfg.enabled ? fsBackdrop.url : '';

  const nextTrack = useQueueTrackAt(queueIndex + 1);

  const { isIdle, handleMouseMove } = useFsIdleFade(onClose);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);

  const metaParts = useMemo(
    () => [currentTrack?.year?.toString(), currentTrack?.genre].filter(Boolean) as string[],
    [currentTrack?.year, currentTrack?.genre],
  );
  // Override-aware rating (a just-set rating lives in the override before it syncs
  // back onto the track object).
  const rating = usePlayerStore(s => {
    const track = s.currentTrack;
    if (!track) return 0;
    return track.id in s.userRatingOverrides ? s.userRatingOverrides[track.id] : (track.userRating ?? 0);
  });
  // Hover preview for the clickable rating stars (0 = no preview).
  const [hoverRating, setHoverRating] = useState(0);
  const applyRating = useCallback((stars: number) => {
    if (!currentTrack) return;
    // Click the current rating again to clear it (matches StarRating's toggle-off).
    queueSongRating(currentTrack.id, rating === stars ? 0 : stars);
  }, [currentTrack, rating]);

  return (
    <div
      className="fsp"
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fullscreen')}
      data-idle={isIdle}
      onMouseMove={handleMouseMove}
    >
      {/* Sharp background — no blur; eases in once its pixels are loaded. */}
      <FsBackground key={bgUrl} url={bgUrl} />
      <div className="fsp-scrim" aria-hidden="true" />
      <div className="fsp-vignette" aria-hidden="true" />

      {/* Top bar */}
      <div className="fsp-top">
        <div className="fsp-nowplaying">
          <span className="fsp-nowplaying-label">{t('player.fsNowPlaying')}</span>
          {queueLen > 0 && (
            <span className="fsp-nowplaying-pos">{t('player.fsTrackPosition', { current: queueIndex + 1, total: queueLen })}</span>
          )}
        </div>
        <FsClock />
      </div>

      <button className="fsp-close" onClick={onClose} aria-label={t('player.closeFullscreen')}>
        <ChevronDown size={20} />
      </button>

      {/* Bottom bar */}
      <div className="fsp-foot">
        <div className="fsp-info-row">
          {/* Big cover — bottom-aligned with the text, top pokes above the bar */}
          <div className="fsp-cover">
            {thumbUrl
              ? <img className="fsp-cover-img" src={thumbUrl} alt="" draggable={false} />
              : <div className="fsp-cover-img fsp-cover-img--empty" />}
          </div>
          <div className="fsp-info-text">
            <p className="fsp-title">{currentTrack?.title ?? '—'}</p>
            <p className="fsp-artist">{currentTrack?.artist ?? '—'}</p>
            {currentTrack && (
              <div className="fsp-meta">
                {metaParts.map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="fsp-meta-dot">·</span>}
                    <span>{part}</span>
                  </React.Fragment>
                ))}
                <span
                  className="fsp-stars"
                  role="radiogroup"
                  aria-label={t('albumDetail.ratingLabel')}
                  onMouseLeave={() => setHoverRating(0)}
                >
                  {Array.from({ length: 5 }, (_, i) => {
                    const n = i + 1;
                    const filled = (hoverRating || rating) >= n;
                    return (
                      <button
                        key={i}
                        type="button"
                        className="fsp-star-btn"
                        role="radio"
                        aria-checked={rating === n}
                        aria-label={`${n}`}
                        onMouseEnter={() => setHoverRating(n)}
                        onClick={() => applyRating(n)}
                      >
                        <Star size={16} fill={filled ? 'currentColor' : 'none'} strokeWidth={1.5} />
                      </button>
                    );
                  })}
                </span>
              </div>
            )}
            {nextTrack && (
              <p className="fsp-next">{t('player.fsNext')}: {nextTrack.artist} – {nextTrack.title}</p>
            )}
          </div>
        </div>

        <div className="fsp-controls" ref={controlsRef}>
          <div className="fsp-transport">
            <button className="fsp-btn" onClick={() => previous()} aria-label={t('player.prev')} data-tooltip={t('player.prev')}>
              <SkipBack size={20} />
            </button>
            <FsPlayBtn controlsAnchorRef={controlsRef} />
            <button className="fsp-btn fsp-btn-sm" onClick={stop} aria-label={t('player.stop')} data-tooltip={t('player.stop')}>
              <Square size={14} fill="currentColor" />
            </button>
            <button className="fsp-btn" onClick={() => next()} aria-label={t('player.next')} data-tooltip={t('player.next')}>
              <SkipForward size={20} />
            </button>
          </div>

          <FsTimeReadout duration={duration} />

          <div className="fsp-actions">
            <button className="fsp-btn fsp-btn-sm" onClick={() => setQueueOpen(true)} aria-label={t('queue.title')} data-tooltip={t('queue.title')}>
              <ListMusic size={20} />
            </button>
            <button
              className={`fsp-btn fsp-btn-sm${lyricsOpen ? ' active' : ''}`}
              onClick={() => setLyricsOpen(v => !v)}
              aria-label={t('player.lyrics')}
              data-tooltip={t('player.lyrics')}
            >
              <MicVocal size={20} />
            </button>
            {currentTrack && (
              <button
                className={`fsp-btn fsp-btn-sm${isStarred ? ' active' : ''}`}
                onClick={toggleStar}
                aria-label={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
                data-tooltip={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              >
                <Heart size={20} fill={isStarred ? 'currentColor' : 'none'} />
              </button>
            )}
            <button
              className={`fsp-btn fsp-btn-sm${repeatMode !== 'off' ? ' active' : ''}`}
              onClick={toggleRepeat}
              aria-label={t('player.repeat')}
              data-tooltip={`${t('player.repeat')}: ${repeatMode === 'off' ? t('player.repeatOff') : repeatMode === 'all' ? t('player.repeatAll') : t('player.repeatOne')}`}
            >
              {repeatMode === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
            </button>
            <button className="fsp-btn fsp-btn-sm" onClick={shuffleUpcomingQueue} aria-label={t('player.shuffle')} data-tooltip={t('player.shuffle')}>
              <Shuffle size={20} />
            </button>
          </div>
        </div>

        {/* True waveform seekbar (cucadmuh's idea) instead of the thin bar. */}
        <WaveformSeek trackId={currentTrack?.id} />
      </div>

      {queueOpen && <FsQueueModal onClose={() => setQueueOpen(false)} />}

      {/* Scrolling synced lyrics (reuses FsLyricsApple) in a semi-transparent
          overlay over the upper area. */}
      {lyricsOpen && (
        <div className="fsp-lyrics-overlay">
          <FsLyricsApple currentTrack={currentTrack} />
        </div>
      )}
    </div>
  );
}
