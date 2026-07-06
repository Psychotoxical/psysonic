import { queueSongStar, playbackCoverArtForAlbum, usePlayerStore } from '@/features/playback';
import { usePlaybackCoverArt } from '@/cover/usePlaybackCoverArt';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import {
  SkipBack, SkipForward,
  ChevronDown, Repeat, Repeat1, Square, Heart, MicVocal,
} from 'lucide-react';
import { useCachedUrl } from '@/ui/CachedImage';
import { getCachedBlob } from '@/cover/imageCache';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useFsArtistBackdrop } from '@/features/fullscreenPlayer/hooks/useFsArtistBackdrop';
import { FsLyricsApple } from './FsLyricsApple';
import { FsLyricsRail } from './FsLyricsRail';
import { FsArt } from './FsArt';
import { FsPortrait } from './FsPortrait';
import { FsSeekbar } from './FsSeekbar';
import { FsLyricsMenu } from './FsLyricsMenu';
import { FsPlayBtn } from './FsPlayBtn';
import { useFsDynamicAccent } from '@/features/fullscreenPlayer/hooks/useFsDynamicAccent';
import { useFsIdleFade } from '@/features/fullscreenPlayer/hooks/useFsIdleFade';
import { useQueueTrackAt } from '@/features/queue';

interface FullscreenPlayerProps {
  onClose: () => void;
}

export default function FullscreenPlayer({ onClose }: FullscreenPlayerProps) {
  const { t } = useTranslation();
  const currentTrack       = usePlayerStore(s => s.currentTrack);
  const repeatMode         = usePlayerStore(s => s.repeatMode);
  const next               = usePlayerStore(s => s.next);
  const previous           = usePlayerStore(s => s.previous);
  const stop               = usePlayerStore(s => s.stop);
  const toggleRepeat       = usePlayerStore(s => s.toggleRepeat);
  // Derive isStarred inside the selector so we only re-render when the boolean
  // actually flips — not when any unrelated track's star status changes.
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
  // the same album — a per-track ref re-keys on `mf-<trackId>` coverArt and
  // reloads/flickers the cover on every song advance (same fix as the Minimal player).
  const playbackCoverRef =
    useAlbumCoverRef(currentTrack?.albumId, undefined, undefined, { libraryResolve: false }) ?? undefined;

  const artCover = usePlaybackCoverArt(playbackCoverRef, 300);
  const artUrl = artCover.src;
  const artKey = artCover.cacheKey;
  const portraitCover = usePlaybackCoverArt(playbackCoverRef, 500);
  const coverUrl = portraitCover.src;
  const coverKey = portraitCover.cacheKey;
  // `false` = no fetchUrl fallback — prevents double crossfade (fetchUrl → blobUrl).
  const resolvedCoverUrl = useCachedUrl(coverUrl, coverKey, false);

  // Dynamic accent color extracted from the current album cover, applied as
  // --dynamic-fs-accent on the root element. Cache hits return instantly so
  // same-album tracks reuse the color without re-fetching.
  const dynamicAccent = useFsDynamicAccent(artUrl, artKey);

  // Artist image → portrait on right. Resolved through the shared fullscreen
  // backdrop hook (banner / fanart.tv / Navidrome artist cover, in the user's
  // configured fullscreen-player source order) — the same source the Minimal
  // player uses. Falls back to the album cover when nothing resolves.
  const artistBgUrl = useFsArtistBackdrop(currentTrack);
  const portraitUrl = artistBgUrl || resolvedCoverUrl;
  const showFullscreenLyrics   = useAuthStore(s => s.showFullscreenLyrics);
  const fsLyricsStyle          = useAuthStore(s => s.fsLyricsStyle);
  const showFsArtistPortrait   = useAuthStore(s => s.showFsArtistPortrait);
  const fsPortraitDim          = useAuthStore(s => s.fsPortraitDim);
  const isAppleMode = showFullscreenLyrics && fsLyricsStyle === 'apple';

  // Pre-fetch next track's 300px cover into the IndexedDB cache. Resolver-first
  // (thin-state): the next ref resolves from the cache (the prefetch window
  // around the current index keeps it warm).
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const nextTrack = useQueueTrackAt(queueIndex + 1);
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const activeServerId = useAuthStore(s => s.activeServerId);
  useEffect(() => {
    if (!nextTrack?.albumId || !nextTrack.coverArt) return;
    const { src: url, cacheKey: key } = playbackCoverArtForAlbum(
      nextTrack.albumId,
      nextTrack.coverArt,
      300,
    );
    getCachedBlob(url, key).catch(() => {});
  }, [nextTrack?.albumId, nextTrack?.coverArt, queueServerId, activeServerId]);

  // Lyrics settings popover state
  const [lyricsMenuOpen, setLyricsMenuOpen] = useState(false);
  const closeLyricsMenu = useCallback(() => setLyricsMenuOpen(false), []);
  const lyricsMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const fsControlsRef = useRef<HTMLDivElement>(null);

  // Idle-fade system — hides controls after 3 s of inactivity; Esc closes.
  const { isIdle, handleMouseMove } = useFsIdleFade(onClose);

  const metaParts = useMemo(() => [
    currentTrack?.album,
    currentTrack?.year?.toString(),
    currentTrack?.suffix?.toUpperCase(),
    currentTrack?.bitRate ? `${currentTrack.bitRate} kbps` : '',
  ].filter(Boolean), [currentTrack]);

  return (
    <div
      className="fs-player"
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fullscreen')}
      data-idle={isIdle}
      data-lyrics={isAppleMode || undefined}
      onMouseMove={handleMouseMove}
      style={{
        ...(dynamicAccent ? { '--dynamic-fs-accent': dynamicAccent } : {}),
        '--fs-portrait-dim': String(fsPortraitDim / 100),
      } as React.CSSProperties}
    >

      {/* Layer 0 — animated dark mesh gradient (real divs = will-change possible) */}
      <div className="fs-mesh-bg" aria-hidden="true">
        <div className="fs-mesh-blob fs-mesh-blob-a" />
        <div className="fs-mesh-blob fs-mesh-blob-b" />
      </div>

      {/* Apple/scrolling lyrics fill the width and hide the right-half portrait,
          so the artist image renders as a dimmed full-screen backdrop instead. */}
      {isAppleMode && showFsArtistPortrait && portraitUrl && (
        <div
          className="fs-apple-backdrop"
          style={{ backgroundImage: `url("${portraitUrl}")` }}
          aria-hidden="true"
        />
      )}

      {/* Layer 1 — artist portrait, right half. Not mounted in Apple mode: the
          full-screen backdrop above already shows the image, so rendering the
          (CSS-hidden) portrait too would load/decode the same image twice. */}
      {showFsArtistPortrait && !isAppleMode && <FsPortrait url={portraitUrl} />}

      {/* Layer 2 — horizontal scrim: dark left → transparent right */}
      <div className="fs-scrim" aria-hidden="true" />

      {/* Close */}
      <button className="fs-close" onClick={onClose} aria-label={t('player.closeFullscreen')}>
        <ChevronDown size={28} />
      </button>

      {/* Lyrics: Apple Music-style (scrolling) or classic 5-line rail */}
      {showFullscreenLyrics && fsLyricsStyle === 'apple' && <FsLyricsApple currentTrack={currentTrack} />}
      {showFullscreenLyrics && fsLyricsStyle === 'apple' && <div className="fsa-fade-top"    aria-hidden="true" />}
      {showFullscreenLyrics && fsLyricsStyle === 'apple' && <div className="fsa-fade-bottom" aria-hidden="true" />}
      {showFullscreenLyrics && fsLyricsStyle === 'rail'  && <FsLyricsRail  currentTrack={currentTrack} />}

      {/* Layer 3 — info cluster, bottom-left */}
      <div className="fs-cluster">

        {/* Album art */}
        <div className="fs-art-wrap">
          <FsArt fetchUrl={artUrl} cacheKey={artKey} />
        </div>

        {/* Track title — massive statement */}
        <p className="fs-track-title">{currentTrack?.title ?? '—'}</p>

        {/* Artist — secondary, below track */}
        <p className="fs-artist-name">{currentTrack?.artist ?? '—'}</p>

        {/* Metadata row */}
        {metaParts.length > 0 && (
          <div className="fs-meta">
            {metaParts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="fs-meta-dot">·</span>}
                <span>{part}</span>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="fs-controls" ref={fsControlsRef}>
          <button className="fs-btn fs-btn-sm" onClick={stop} aria-label={t('player.stop')} data-tooltip={t('player.stop')}>
            <Square size={13} fill="currentColor" />
          </button>
          <button className="fs-btn" onClick={() => previous()} aria-label={t('player.prev')} data-tooltip={t('player.prev')}>
            <SkipBack size={19} />
          </button>
          <FsPlayBtn controlsAnchorRef={fsControlsRef} />
          <button className="fs-btn" onClick={() => next()} aria-label={t('player.next')} data-tooltip={t('player.next')}>
            <SkipForward size={19} />
          </button>
          <button
            className={`fs-btn fs-btn-sm${repeatMode !== 'off' ? ' active' : ''}`}
            onClick={toggleRepeat}
            aria-label={t('player.repeat')}
            data-tooltip={`${t('player.repeat')}: ${repeatMode === 'off' ? t('player.repeatOff') : repeatMode === 'all' ? t('player.repeatAll') : t('player.repeatOne')}`}
          >
            {repeatMode === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
          </button>
          {currentTrack && (
            <button
              className={`fs-btn fs-btn-sm fs-btn-heart${isStarred ? ' active' : ''}`}
              onClick={toggleStar}
              aria-label={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              data-tooltip={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
            >
              <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
            </button>
          )}
          <div style={{ position: 'relative', zIndex: 9 }}>
            <FsLyricsMenu open={lyricsMenuOpen} onClose={closeLyricsMenu} accentColor={dynamicAccent} triggerRef={lyricsMenuTriggerRef} />
            <button
              ref={lyricsMenuTriggerRef}
              className={`fs-btn fs-btn-sm${lyricsMenuOpen ? ' active' : ''}`}
              onClick={() => setLyricsMenuOpen(v => !v)}
              aria-label={t('player.fsLyricsToggle')}
              data-tooltip={lyricsMenuOpen ? undefined : t('player.fsLyricsToggle')}
              style={{ color: showFullscreenLyrics ? (dynamicAccent ?? 'var(--accent)') : 'rgba(255,255,255,0.35)' }}
            >
              <MicVocal size={14} />
            </button>
          </div>
        </div>

      </div>

      {/* Layer 4 — full-width seekbar, bottom edge */}
      <FsSeekbar duration={duration} />

    </div>
  );
}
