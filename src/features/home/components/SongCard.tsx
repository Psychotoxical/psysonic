import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import React, { memo, useMemo } from 'react';
import { Play, ListPlus, Star, Disc3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useCoverArt } from '@/cover/useCoverArt';
import { useTrackCoverRef } from '@/cover/useLibraryCoverRef';
import { COVER_DENSE_RAIL_CELL_CSS_PX } from '@/cover/layoutSizes';
import { enqueueAndPlay } from '@/features/playback/utils/playback/playSong';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { useOrbitSongRowBehavior } from '@/features/orbit';
import { useNavigateToAlbum } from '@/features/album';
import { useNavigateToArtist } from '@/features/artist';
import { OpenArtistRefInline } from '@/ui/OpenArtistRefInline';
import { resolveTrackArtistRefs } from '@/features/playback/utils/playback/trackArtistRefs';
import { appendServerQuery } from '@/lib/navigation/detailServerScope';

interface SongCardProps {
  song: SubsonicSong;
  disableArtwork?: boolean;
  /** Layout-native cover square width in CSS px (rail cell). */
  displayCssPx?: number;
  /** @deprecated Use displayCssPx */
  artworkSize?: number;
}

function SongCard({
  song,
  disableArtwork = false,
  displayCssPx = COVER_DENSE_RAIL_CELL_CSS_PX,
  artworkSize,
}: SongCardProps) {
  const layoutPx = artworkSize ?? displayCssPx;
  const { t } = useTranslation();
  const navigateToArtist = useNavigateToArtist();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);
  const coverRef = useTrackCoverRef(song, undefined, { libraryResolve: false });
  const coverHandle = useCoverArt(coverRef, layoutPx, {
    surface: 'dense',
    ensurePriority: 'middle',
  });
  const coverUrl = coverHandle.src;
  const psyDrag = useDragDrop();
  const { orbitActive, addTrackToOrbit } = useOrbitSongRowBehavior();
  const navigateToAlbum = useNavigateToAlbum();
  const serverSearch = appendServerQuery(undefined, song.serverId);

  const handlePlay = () => {
    if (orbitActive) { addTrackToOrbit(song.id); return; }
    enqueueAndPlay(song);
  };

  const handleEnqueue = () => {
    if (orbitActive) { addTrackToOrbit(song.id); return; }
    enqueue([songToTrack(song)]);
  };

  const handleClick = handlePlay;
  const artistRefs = useMemo(() => resolveTrackArtistRefs(song), [song]);

  const handleAlbumClick = (e: React.MouseEvent) => {
    if (!song.albumId) return;
    e.stopPropagation();
    if (serverSearch) navigateToAlbum(song.albumId, { search: serverSearch });
    else navigateToAlbum(song.albumId);
  };

  return (
    <div
      className="song-card card"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={`${song.title} – ${song.artist}`}
      onKeyDown={e => e.key === 'Enter' && handleClick()}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, song, 'song');
      }}
      onMouseDown={e => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            psyDrag.startDrag(
              { data: JSON.stringify({ type: 'song', id: song.id, name: song.title }), label: song.title, coverUrl: coverUrl || undefined },
              me.clientX, me.clientY,
            );
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    >
      <div className="song-card-cover cover-circle">
        {!disableArtwork && coverRef ? (
          <CoverArtImage
            coverRef={coverRef}
            displayCssPx={layoutPx}
            surface="dense"
            alt={`${song.album} Cover`}
            loading="eager"
            decoding="async"
          />
        ) : (
          <div className="song-card-cover-placeholder">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
        )}
        <div className="song-card-play-overlay">
          <button
            className="song-card-action-btn"
            onClick={e => { e.stopPropagation(); handlePlay(); }}
            aria-label={t('tracks.playSong')}
            data-tooltip={t('tracks.playSong')}
            data-tooltip-pos="top"
          >
            <Play size={14} fill="currentColor" />
          </button>
          <button
            className="song-card-action-btn"
            onClick={e => { e.stopPropagation(); handleEnqueue(); }}
            aria-label={t('tracks.enqueueSong')}
            data-tooltip={t('tracks.enqueueSong')}
            data-tooltip-pos="top"
          >
            <ListPlus size={14} />
          </button>
        </div>
      </div>
      <div className="song-card-info">
        <p className="song-card-title truncate" title={song.title}>{song.title}</p>
        <p className="song-card-artist truncate" title={song.artist}>
          <OpenArtistRefInline
            refs={artistRefs}
            fallbackName={song.artist}
            onGoArtist={id => {
              if (serverSearch) navigateToArtist(id, { search: serverSearch });
              else navigateToArtist(id);
            }}
            as="none"
            linkTag="span"
            linkClassName="track-artist-link"
          />
        </p>
        {song.albumId && (
          <button
            type="button"
            className="song-card-album-badge"
            onClick={handleAlbumClick}
            aria-label={`${t('tracks.toAlbum')} – ${song.album}`}
            title={song.album}
          >
            <Disc3 size={11} />
            <span>{t('tracks.toAlbum')}</span>
          </button>
        )}
        {(song.userRating ?? 0) > 0 && (
          <div className="song-card-rating" aria-label={`${song.userRating} stars`}>
            {Array.from({ length: 5 }, (_, i) => (
              <Star
                key={i}
                size={11}
                fill={i < (song.userRating ?? 0) ? 'currentColor' : 'none'}
                strokeWidth={1.5}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(SongCard);
