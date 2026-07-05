import React, { useEffect, useState } from 'react';
import { resolveAlbum, resolveArtist, resolveMediaServerId } from '@/features/offline';
import { AddToPlaylistSubmenu } from '@/features/contextMenu/components/AddToPlaylistSubmenu';

interface AlbumProps {
  albumId: string;
  onDone: () => void;
  triggerId?: string;
}

export function AlbumToPlaylistSubmenu({ albumId, onDone, triggerId }: AlbumProps) {
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);

  useEffect(() => {
    const serverId = resolveMediaServerId();
    if (!serverId) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResolvedIds([]);
      return;
    }
    resolveAlbum(serverId, albumId).then((data) => {
      setResolvedIds(data ? data.songs.map((s) => s.id) : []);
    }).catch(() => setResolvedIds([]));
  }, [albumId]);

  if (resolvedIds === null) {
    return (
      <div className="context-submenu" style={{ display: 'flex', justifyContent: 'center', padding: '0.75rem' }}>
        <div className="spinner" style={{ width: 16, height: 16 }} />
      </div>
    );
  }
  if (resolvedIds.length === 0) return null;
  return <AddToPlaylistSubmenu songIds={resolvedIds} onDone={onDone} triggerId={triggerId} />;
}

interface ArtistProps {
  artistId: string;
  onDone: () => void;
  triggerId?: string;
}

export function ArtistToPlaylistSubmenu({ artistId, onDone, triggerId }: ArtistProps) {
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);

  useEffect(() => {
    (async () => {
      const serverId = resolveMediaServerId();
      if (!serverId) {
        setResolvedIds([]);
        return;
      }
      const artistData = await resolveArtist(serverId, artistId);
      if (!artistData) {
        setResolvedIds([]);
        return;
      }
      const albumSongs = await Promise.all(
        artistData.albums.map(a => resolveAlbum(serverId, a.id).then(r => r?.songs ?? [])),
      );
      setResolvedIds(albumSongs.flat().map(s => s.id));
    })().catch(() => setResolvedIds([]));
  }, [artistId]);

  if (resolvedIds === null) {
    return (
      <div className="context-submenu" style={{ display: 'flex', justifyContent: 'center', padding: '0.75rem' }}>
        <div className="spinner" style={{ width: 16, height: 16 }} />
      </div>
    );
  }
  if (resolvedIds.length === 0) return null;
  return <AddToPlaylistSubmenu songIds={resolvedIds} onDone={onDone} triggerId={triggerId} />;
}
