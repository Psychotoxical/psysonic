import React, { useEffect, useState } from 'react';
import { getAlbum } from '../../api/subsonicLibrary';
import { getArtist } from '../../api/subsonicArtists';
import { AddToPlaylistSubmenu } from './AddToPlaylistSubmenu';

interface AlbumProps {
  albumId: string;
  onDone: () => void;
  triggerId?: string;
}

export function AlbumToPlaylistSubmenu({ albumId, onDone, triggerId }: AlbumProps) {
  const [resolvedIds, setResolvedIds] = useState<string[] | null>(null);

  useEffect(() => {
    getAlbum(albumId).then((data) => {
      setResolvedIds(data.songs.map((s) => s.id));
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
      const { albums } = await getArtist(artistId);
      const albumSongs = await Promise.all(albums.map(a => getAlbum(a.id).then(r => r.songs)));
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
