import React, { useEffect } from 'react';
import { Music } from 'lucide-react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { usePlaybackTrackCoverRef, useTrackCoverRef } from '@/cover/useLibraryCoverRef';
import { wakeCoverBackfillForMissingTrack } from '@/cover/wakeCoverBackfillForMissingTrack';
import {
  COVER_ARTIST_TOP_TRACK_CSS_PX,
  COVER_TRACK_ROW_CSS_PX,
  COVER_TRACK_ROW_MINI_CSS_PX,
} from '@/cover/layoutSizes';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import type { CoverArtRef } from '@/cover/types';
import type { TrackListCoverArtSurface } from '@/cover/useTrackListCoverArtSettings';
import { useTrackListCoverArtEnabled } from '@/cover/useTrackListCoverArtSettings';

export type TrackRowCoverSong = Pick<
  SubsonicSong,
  'id' | 'albumId' | 'coverArt' | 'discNumber'
> & {
  serverId?: string;
  /** Queue placeholder rows use title '…' until resolved. */
  title?: string;
};

export type TrackRowCoverThumbSize = 'row' | 'mini' | 'dense';

const SIZE_PX: Record<TrackRowCoverThumbSize, number> = {
  row: COVER_TRACK_ROW_CSS_PX,
  mini: COVER_TRACK_ROW_MINI_CSS_PX,
  dense: COVER_ARTIST_TOP_TRACK_CSS_PX,
};

interface BaseProps {
  song: TrackRowCoverSong;
  size?: TrackRowCoverThumbSize;
  className?: string;
  /** When omitted, CoverArtImage resolves the nearest scroll ancestor. */
  observeScrollRootId?: string;
}

interface Props extends BaseProps {
  surface: TrackListCoverArtSurface;
}

function isUnresolvedQueuePlaceholder(song: TrackRowCoverSong): boolean {
  return song.title === '…' || !song.id?.trim();
}

function TrackRowCoverPlaceholder({
  displayCssPx,
  className,
  showIcon,
}: {
  displayCssPx: number;
  className?: string;
  showIcon?: boolean;
}) {
  return (
    <div
      className={`track-row-cover-thumb track-row-cover-thumb--placeholder${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      {showIcon ? <Music size={Math.round(displayCssPx * 0.38)} /> : null}
    </div>
  );
}

function TrackRowCoverImage({
  coverRef,
  displayCssPx,
  className,
  observeScrollRootId,
}: {
  coverRef: CoverArtRef;
  displayCssPx: number;
  className?: string;
  observeScrollRootId?: string;
}) {
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={displayCssPx}
      surface="dense"
      observeScrollRootId={observeScrollRootId}
      className={`track-row-cover-thumb${className ? ` ${className}` : ''}`}
      alt=""
      loading="lazy"
      decoding="async"
    />
  );
}

/**
 * Browse/detail track rows — album cover (multi-disc exception) via library
 * index + standard dense ensure pipeline.
 */
export function BrowseTrackRowCoverThumb({
  song,
  size = 'row',
  className,
  observeScrollRootId,
}: BaseProps) {
  const displayCssPx = SIZE_PX[size];
  const albumId = song.albumId?.trim();
  const serverScope = coverServerScopeForServerId(song.serverId);
  const coverRef = useTrackCoverRef(song, serverScope, { libraryResolve: true });
  const missingApiCoverArt = !song.coverArt?.trim();

  useEffect(() => {
    if (missingApiCoverArt) wakeCoverBackfillForMissingTrack(song);
    // song is read only for albumId/coverArt inside the wake helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingApiCoverArt, song.id, song.albumId]);

  if (!albumId || !coverRef) {
    return <TrackRowCoverPlaceholder displayCssPx={displayCssPx} className={className} showIcon />;
  }

  return (
    <TrackRowCoverImage
      coverRef={coverRef}
      displayCssPx={displayCssPx}
      className={className}
      observeScrollRootId={observeScrollRootId}
    />
  );
}

/**
 * Queue rows — same resolver as playbar / queue hero (`usePlaybackTrackCoverRef`)
 * so server switches keep the correct playback scope and album/disc slot.
 */
export function QueueTrackRowCoverThumb({
  song,
  size = 'row',
  className,
  observeScrollRootId,
}: BaseProps) {
  const displayCssPx = SIZE_PX[size];
  const albumId = song.albumId?.trim();
  const coverRef = usePlaybackTrackCoverRef(song);
  const missingApiCoverArt = !song.coverArt?.trim();

  useEffect(() => {
    if (missingApiCoverArt) wakeCoverBackfillForMissingTrack(song);
    // song is read only for albumId/coverArt inside the wake helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingApiCoverArt, song.id, song.albumId]);

  if (isUnresolvedQueuePlaceholder(song)) {
    return <TrackRowCoverPlaceholder displayCssPx={displayCssPx} className={className} />;
  }

  if (!albumId || !coverRef) {
    return <TrackRowCoverPlaceholder displayCssPx={displayCssPx} className={className} showIcon />;
  }

  return (
    <TrackRowCoverImage
      coverRef={coverRef}
      displayCssPx={displayCssPx}
      className={className}
      observeScrollRootId={observeScrollRootId}
    />
  );
}

/** Routes to browse vs queue resolver based on `surface`. */
export function TrackRowCoverThumb({ surface, ...props }: Props) {
  if (surface === 'queue') return <QueueTrackRowCoverThumb {...props} />;
  return <BrowseTrackRowCoverThumb {...props} />;
}

/** Respects the persisted toggle for `surface` — use in list rows. */
export function OptionalTrackRowCoverThumb(props: Props) {
  const enabled = useTrackListCoverArtEnabled(props.surface);
  if (!enabled) return null;
  return <TrackRowCoverThumb {...props} />;
}

/** Queue lists — respects queue toggle. */
export function OptionalQueueTrackRowCoverThumb(
  props: Omit<Props, 'surface'>,
) {
  return <OptionalTrackRowCoverThumb {...props} surface="queue" />;
}

/** Browse tracklists — respects pages toggle. */
export function OptionalBrowseTrackRowCoverThumb(
  props: Omit<Props, 'surface'>,
) {
  return <OptionalTrackRowCoverThumb {...props} surface="pages" />;
}
