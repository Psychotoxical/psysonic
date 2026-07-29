import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { resolveTrackArtistRefs } from '@/features/playback/utils/playback/trackArtistRefs';
import { useAuthStore } from '@/store/authStore';
import { buildArtistDetailPath } from '@/lib/navigation/detailServerScope';
import { ResolvedArtistRefInline } from '@/ui/ResolvedArtistRefInline';

/**
 * Multi-artist credit for playlist track rows (main list + suggestions).
 * Renders the OpenSubsonic `artists` array as ·-separated, individually
 * navigable links, falling back to the legacy `artist`/`artistId` pair.
 * Mirrors the album track list (TrackRow) so a track reads the same before
 * and after it is added to the playlist — same component, so a guest split out
 * of a joined credit is linkable and keyboard-reachable here too.
 */
export function PlaylistArtistCell({ song }: { song: SubsonicSong }) {
  const navigate = useNavigate();
  const activeServerId = useAuthStore(s => s.activeServerId ?? '');
  const artistRefs = useMemo(() => resolveTrackArtistRefs(song), [song]);
  return (
    <div className="track-artist-cell">
      <ResolvedArtistRefInline
        refs={artistRefs}
        serverId={song.serverId ?? activeServerId}
        fallbackName={song.artist}
        onGoArtist={id => navigate(buildArtistDetailPath(id, { serverId: song.serverId }))}
        as="none"
        linkTag="span"
        plainClassName="track-artist"
        linkClassName="track-artist-link"
        separatorClassName="track-artist-sep"
      />
    </div>
  );
}
