import React, { useEffect, useRef, useState } from 'react';
import { Play, ListPlus, Radio, Star, Download, ChevronRight, User } from 'lucide-react';
import { usePlayerStore, Track } from '../store/playerStore';
import { SubsonicAlbum, SubsonicArtist, star, unstar, getSimilarSongs2, getTopSongs, buildDownloadUrl, getAlbum } from '../api/subsonic';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { open } from '@tauri-apps/plugin-shell';
import { writeFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { useTranslation } from 'react-i18next';

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

export default function ContextMenu() {
  const { t } = useTranslation();
  const { contextMenu, closeContextMenu, playTrack, enqueue, queue, currentTrack, removeTrack } = usePlayerStore();
  const auth = useAuthStore();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjusted coordinates to keep menu on screen
  const [coords, setCoords] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (contextMenu.isOpen) {
      setCoords({ x: contextMenu.x, y: contextMenu.y });
    }
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y]);

  useEffect(() => {
    if (contextMenu.isOpen && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      let finalX = contextMenu.x;
      let finalY = contextMenu.y;
      if (finalX + rect.width > winW) finalX = winW - rect.width - 10;
      if (finalY + rect.height > winH) finalY = winH - rect.height - 10;
      setCoords({ x: finalX, y: finalY });
    }
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y]);

  if (!contextMenu.isOpen || !contextMenu.item) return null;

  const { type, item, queueIndex } = contextMenu;

  const handleAction = async (action: () => void | Promise<void>) => {
    closeContextMenu();
    await action();
  };

  const startRadio = async (artistId: string, artistName: string) => {
    try {
      const similar = await getSimilarSongs2(artistId);
      if (similar.length > 0) {
        const top = await getTopSongs(artistName);
        const radioTracks = [...top, ...similar].map(s => ({
          id: s.id, title: s.title, artist: s.artist, album: s.album,
          albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
          year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
        }));
        playTrack(radioTracks[0], radioTracks);
      }
    } catch (e) {
      console.error('Failed to start radio', e);
    }
  };

  const downloadAlbum = async (albumName: string, albumId: string) => {
    try {
      const url = buildDownloadUrl(albumId);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();

      if (auth.downloadFolder) {
        const buffer = await blob.arrayBuffer();
        const path = await join(auth.downloadFolder, `${sanitizeFilename(albumName)}.zip`);
        await writeFile(path, new Uint8Array(buffer));
      } else {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${sanitizeFilename(albumName)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
      }
    } catch (e) {
      console.error('Download failed:', e);
    }
  };

  return (
    <>
      {/* Transparent backdrop — catches all outside clicks cleanly, preventing freeze */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 998 }}
        onMouseDown={() => closeContextMenu()}
      />
      <div
        ref={menuRef}
        className="context-menu animate-fade-in"
        style={{ left: coords.x, top: coords.y, zIndex: 999 }}
      >
        {(type === 'song' || type === 'album-song') && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, [song]))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => {
                if (!currentTrack) {
                  playTrack(song, [song]);
                  return;
                }
                const currentIdx = usePlayerStore.getState().queueIndex;
                const newQueue = [...queue];
                newQueue.splice(currentIdx + 1, 0, song);
                usePlayerStore.setState({ queue: newQueue });
              })}>
                <ChevronRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => enqueue([song]))}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              {type === 'album-song' && (
                <div className="context-menu-item" onClick={() => handleAction(async () => {
                  const albumData = await getAlbum(song.albumId);
                  const tracks = albumData.songs.map(s => ({
                    id: s.id, title: s.title, artist: s.artist, album: s.album,
                    albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
                    year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
                  }));
                  enqueue(tracks);
                })}>
                  <ListPlus size={14} /> {t('contextMenu.enqueueAlbum')}
                </div>
              )}
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artist, song.artist))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => star(song.id, 'song'))}>
                <Star size={14} /> {t('contextMenu.favorite')}
              </div>
            </>
          );
        })()}

        {type === 'album' && (() => {
          const album = item as SubsonicAlbum;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${album.id}`))}>
                <Play size={14} /> {t('contextMenu.openAlbum')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${album.artistId}`))}>
                <User size={14} /> {t('contextMenu.goToArtist')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => star(album.id, 'album'))}>
                <Star size={14} /> {t('contextMenu.favoriteAlbum')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => downloadAlbum(album.name, album.id))}>
                <Download size={14} /> {t('contextMenu.download')}
              </div>
            </>
          );
        })()}

        {type === 'artist' && (() => {
          const artist = item as SubsonicArtist;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(artist.id, artist.name))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => star(artist.id, 'artist'))}>
                <Star size={14} /> {t('contextMenu.favoriteArtist')}
              </div>
            </>
          );
        })()}

        {type === 'queue-item' && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, queue))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(() => {
                if (queueIndex !== undefined) removeTrack(queueIndex);
              })}>
                {t('contextMenu.removeFromQueue')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artist, song.artist))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
            </>
          );
        })()}
      </div>
    </>
  );
}
