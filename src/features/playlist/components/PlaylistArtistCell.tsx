import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { resolveTrackArtistRefs } from '@/features/playback/utils/playback/trackArtistRefs';

/**
 * Multi-artist credit for playlist track rows (main list + suggestions).
 * Renders the OpenSubsonic `artists` array as ·-separated, individually
 * navigable links, falling back to the legacy `artist`/`artistId` pair.
 * Mirrors the album track list (TrackRow) so a track reads the same before
 * and after it is added to the playlist.
 */
export function PlaylistArtistCell({ song }: { song: SubsonicSong }) {
  const navigate = useNavigate();
  const artistRefs = useMemo(() => resolveTrackArtistRefs(song), [song]);
  return (
    <div className="track-artist-cell">
      {artistRefs.map((a, i) => (
        <React.Fragment key={a.id ?? a.name ?? i}>
          {i > 0 && <span className="track-artist-sep">&nbsp;·&nbsp;</span>}
          <span
            className={`track-artist${a.id ? ' track-artist-link' : ''}`}
            style={{ cursor: a.id ? 'pointer' : 'default' }}
            onClick={e => { if (a.id) { e.stopPropagation(); navigate(`/artist/${a.id}`); } }}
          >
            {a.name ?? song.artist}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
