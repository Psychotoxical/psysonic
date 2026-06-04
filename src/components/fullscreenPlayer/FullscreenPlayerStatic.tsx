import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  SkipBack, SkipForward, Square, Repeat, Repeat1, Heart,
  Shuffle, ListMusic, ChevronDown, Star,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../../store/playerStore';
import { queueSongStar } from '../../store/pendingStarSync';
import { usePlaybackTrackCoverRef } from '../../cover/useLibraryCoverRef';
import { usePlaybackCoverArt } from '../../hooks/usePlaybackCoverArt';
import { useCachedUrl } from '../CachedImage';
import { useFsArtistPortrait } from '../../hooks/useFsArtistPortrait';
import { useFsIdleFade } from '../../hooks/useFsIdleFade';
import { useQueueTrackAt } from '../../hooks/useQueueTracks';
import WaveformSeek from '../WaveformSeek';
import { FsQueueModal } from './FsQueueModal';
import { FsPlayBtn } from './FsPlayBtn';
import { FsClock } from './FsClock';
import { FsTimeReadout } from './FsTimeReadout';

interface Props {
  onClose: () => void;
}

// NOTE: new-label strings (Now playing / Track x of N / Next / shuffle / queue)
// are English-only for the experiment; add the i18n keys before opening a PR.
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
    queueSongStar(currentTrack.id, !isStarred);
  }, [currentTrack, isStarred]);

  const duration = currentTrack?.duration ?? 0;

  // Cover (thumbnail 300px) + a larger one used as the background fallback.
  const playbackCoverRef = usePlaybackTrackCoverRef(currentTrack ?? undefined);
  const artCover = usePlaybackCoverArt(playbackCoverRef, 300);
  // Full-screen background wants a crisp image — fetch the high-res (2000px)
  // cover via the existing on-demand `fullRes` path (cucadmuh's mechanism), not
  // the low-res pipeline tier. Same getCoverArt fetch, saved as a 2000px WebP.
  const bgCover = usePlaybackCoverArt(playbackCoverRef, 2000, { fullRes: true });
  // `true` = show the raw URL immediately while the blob resolves (same as FsArt),
  // otherwise the FS-specific 300/500px keys stay blank until/if they warm.
  const resolvedCoverUrl = useCachedUrl(bgCover.src, bgCover.cacheKey, true);
  const thumbUrl = useCachedUrl(artCover.src, artCover.cacheKey, true);
  // Artist photo is the background; fall back to the album cover.
  const artistBgUrl = useFsArtistPortrait(currentTrack?.artistId);
  const bgUrl = artistBgUrl || resolvedCoverUrl;

  const nextTrack = useQueueTrackAt(queueIndex + 1);

  const { isIdle, handleMouseMove } = useFsIdleFade(onClose);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);

  // Prefix the title with the queue position so it matches "Track x / N".
  const titlePrefix = queueLen > 0
    ? `${String(queueIndex + 1).padStart(2, '0')}. `
    : '';
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

  return (
    <div
      className="fsp"
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fullscreen')}
      data-idle={isIdle}
      onMouseMove={handleMouseMove}
    >
      {/* Static sharp background — no blur, no animation */}
      {bgUrl
        ? <img className="fsp-bg" src={bgUrl} alt="" aria-hidden="true" draggable={false} />
        : <div className="fsp-bg fsp-bg--empty" aria-hidden="true" />}
      <div className="fsp-scrim" aria-hidden="true" />
      <div className="fsp-vignette" aria-hidden="true" />

      {/* Top bar */}
      <div className="fsp-top">
        <div className="fsp-nowplaying">
          <span className="fsp-nowplaying-label">Now playing…</span>
          {queueLen > 0 && (
            <span className="fsp-nowplaying-pos">Track {queueIndex + 1} / {queueLen}</span>
          )}
        </div>
        <FsClock />
      </div>

      <button className="fsp-close" onClick={onClose} aria-label={t('player.closeFullscreen')}>
        <ChevronDown size={28} />
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
            <p className="fsp-title">{titlePrefix}{currentTrack?.title ?? '—'}</p>
            <p className="fsp-artist">{currentTrack?.artist ?? '—'}</p>
            {currentTrack && (
              <div className="fsp-meta">
                {metaParts.map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="fsp-meta-dot">·</span>}
                    <span>{part}</span>
                  </React.Fragment>
                ))}
                <span className="fsp-stars" aria-label={`${rating} / 5`}>
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star key={i} size={16} fill={i < rating ? 'currentColor' : 'none'} strokeWidth={1.5} />
                  ))}
                </span>
              </div>
            )}
            {nextTrack && (
              <p className="fsp-next">Next: {nextTrack.artist} – {nextTrack.title}</p>
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
            <button className="fsp-btn fsp-btn-sm" onClick={() => setQueueOpen(true)} aria-label="Queue" data-tooltip="Queue">
              <ListMusic size={20} />
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
            <button className="fsp-btn fsp-btn-sm" onClick={shuffleUpcomingQueue} aria-label="Shuffle" data-tooltip="Shuffle">
              <Shuffle size={20} />
            </button>
          </div>
        </div>

        {/* True waveform seekbar (cucadmuh's idea) instead of the thin bar. */}
        <WaveformSeek trackId={currentTrack?.id} />
      </div>

      {queueOpen && <FsQueueModal onClose={() => setQueueOpen(false)} />}
    </div>
  );
}
