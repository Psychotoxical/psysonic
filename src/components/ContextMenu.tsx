import { getPlaylists, getPlaylist, updatePlaylist } from '../api/subsonicPlaylists';
import { star, unstar, setRating } from '../api/subsonicStarRating';
import { getAlbum } from '../api/subsonicLibrary';
import { getArtist } from '../api/subsonicArtists';
import type { SubsonicAlbum, SubsonicArtist, SubsonicPlaylist } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import type { Track } from '../store/playerStoreTypes';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Play, ListPlus, Radio, Heart, Download, ChevronRight, ChevronsRight, User, Disc3, ListMusic, Plus, Info, Sparkles, Star, Trash2, HeartCrack, Share2, Orbit as OrbitIcon } from 'lucide-react';
import { useOrbitStore } from '../store/orbitStore';
import {
  suggestOrbitTrack,
  hostEnqueueToOrbit,
  evaluateOrbitSuggestGate,
  OrbitSuggestBlockedError,
} from '../utils/orbit';
import LastfmIcon from './LastfmIcon';
import StarRating from './StarRating';
import { lastfmLoveTrack, lastfmUnloveTrack } from '../api/lastfm';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { usePlaylistStore } from '../store/playlistStore';
import { open } from '@tauri-apps/plugin-shell';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import type { EntityShareKind } from '../utils/shareLink';
import {
  SMART_PLAYLIST_PREFIX,
  confirmAddAllDuplicates,
  isSmartPlaylistName,
} from '../utils/contextMenuHelpers';
import { AddToPlaylistSubmenu } from './contextMenu/AddToPlaylistSubmenu';
import { AlbumToPlaylistSubmenu, ArtistToPlaylistSubmenu } from './contextMenu/AlbumArtistToPlaylistSubmenu';
import { MultiAlbumToPlaylistSubmenu } from './contextMenu/MultiAlbumToPlaylistSubmenu';
import { MultiArtistToPlaylistSubmenu } from './contextMenu/MultiArtistToPlaylistSubmenu';
import {
  MultiPlaylistToPlaylistSubmenu,
  SinglePlaylistToPlaylistSubmenu,
} from './contextMenu/PlaylistToPlaylistSubmenus';
import {
  copyShareLink as copyShareLinkAction,
  downloadAlbum as downloadAlbumAction,
  startInstantMix as startInstantMixAction,
  startRadio as startRadioAction,
} from '../utils/contextMenuActions';
import { useContextMenuKeyboardNav } from '../hooks/useContextMenuKeyboardNav';

export { AddToPlaylistSubmenu };


export default function ContextMenu() {
  const { t } = useTranslation();
  const orbitRole = useOrbitStore(s => s.role);
  const { contextMenu, closeContextMenu, playTrack, enqueue, playNext, queue, currentTrack, removeTrack, lastfmLovedCache, setLastfmLovedForSong, starredOverrides, setStarredOverride, openSongInfo, userRatingOverrides, setUserRatingOverride } = usePlayerStore(
    useShallow(s => ({
      contextMenu: s.contextMenu,
      closeContextMenu: s.closeContextMenu,
      playTrack: s.playTrack,
      enqueue: s.enqueue,
      playNext: s.playNext,
      queue: s.queue,
      currentTrack: s.currentTrack,
      removeTrack: s.removeTrack,
      lastfmLovedCache: s.lastfmLovedCache,
      setLastfmLovedForSong: s.setLastfmLovedForSong,
      starredOverrides: s.starredOverrides,
      setStarredOverride: s.setStarredOverride,
      openSongInfo: s.openSongInfo,
      userRatingOverrides: s.userRatingOverrides,
      setUserRatingOverride: s.setUserRatingOverride,
    }))
  );
  const auth = useAuthStore();
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const entityRatingSupport =
    auth.activeServerId ? auth.entityRatingSupportByServer[auth.activeServerId] ?? 'unknown' : 'unknown';
  const audiomuseNavidromeEnabled = !!(auth.activeServerId && auth.audiomuseNavidromeByServer[auth.activeServerId]);
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Adjusted coordinates to keep menu on screen
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const [playlistSubmenuOpen, setPlaylistSubmenuOpen] = useState(false);
  const [playlistSongIds, setPlaylistSongIds] = useState<string[]>([]);
  const [keyboardRating, setKeyboardRating] = useState<{ kind: 'song' | 'album' | 'artist'; id: string; value: number } | null>(null);
  const [pendingSubmenuKeyboardFocus, setPendingSubmenuKeyboardFocus] = useState(false);

  useEffect(() => {
    if (contextMenu.isOpen) {
      setCoords({ x: contextMenu.x, y: contextMenu.y });
      setPlaylistSubmenuOpen(false);
      setPlaylistSongIds([]);
      setKeyboardRating(null);
      setPendingSubmenuKeyboardFocus(false);
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

  useEffect(() => {
    if (contextMenu.isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    // Clean up any keyboard focus styling when menu closes
    menuRef.current
      ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
      .forEach(el => el.classList.remove('context-menu-keyboard-active'));
    const prev = previousFocusRef.current;
    previousFocusRef.current = null;
    if (prev?.isConnected) {
      requestAnimationFrame(() => {
        prev.focus({ preventScroll: true });
      });
    }
  }, [contextMenu.isOpen, closeContextMenu]);


  const { type, item, queueIndex, playlistId, playlistSongIndex, shareKindOverride } = contextMenu;

  const isStarred = (id: string, itemStarred?: string) =>
    id in starredOverrides ? starredOverrides[id] : !!itemStarred;

  const applySongRating = useCallback((songId: string, rating: number) => {
    setUserRatingOverride(songId, rating);
    setRating(songId, rating).catch(() => {});
  }, [setUserRatingOverride]);

  const applyAlbumRating = useCallback((album: SubsonicAlbum, rating: number) => {
    setUserRatingOverride(album.id, rating);
    if (entityRatingSupport !== 'full') return;
    setRating(album.id, rating).catch(err => {
      if (auth.activeServerId) setEntityRatingSupport(auth.activeServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    });
  }, [setUserRatingOverride, entityRatingSupport, auth.activeServerId, setEntityRatingSupport, t]);

  const applyArtistRating = useCallback((artist: SubsonicArtist, rating: number) => {
    setUserRatingOverride(artist.id, rating);
    if (entityRatingSupport !== 'full') return;
    setRating(artist.id, rating).catch(err => {
      if (auth.activeServerId) setEntityRatingSupport(auth.activeServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    });
  }, [setUserRatingOverride, entityRatingSupport, auth.activeServerId, setEntityRatingSupport, t]);

  const getRatingValueByKind = useCallback((kind: 'song' | 'album' | 'artist', id: string): number => {
    if (kind === 'song' && (type === 'song' || type === 'album-song' || type === 'queue-item')) {
      const song = item as Track;
      if (song.id === id) return userRatingOverrides[id] ?? song.userRating ?? 0;
    }
    if (kind === 'album' && type === 'album') {
      const album = item as SubsonicAlbum;
      if (album.id === id) return userRatingOverrides[id] ?? album.userRating ?? 0;
    }
    if (kind === 'album' && type === 'multi-album') {
      const albums = item as SubsonicAlbum[];
      const compositeId = [...albums.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return userRatingOverrides[id] ?? 0;
      if (albums.length === 0) return 0;
      const vals = albums.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
      const first = vals[0];
      return vals.every(v => v === first) ? first : 0;
    }
    if (kind === 'artist' && type === 'artist') {
      const artist = item as SubsonicArtist;
      if (artist.id === id) return userRatingOverrides[id] ?? artist.userRating ?? 0;
    }
    if (kind === 'artist' && type === 'multi-artist') {
      const artists = item as SubsonicArtist[];
      const compositeId = [...artists.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return userRatingOverrides[id] ?? 0;
      if (artists.length === 0) return 0;
      const vals = artists.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
      const first = vals[0];
      return vals.every(v => v === first) ? first : 0;
    }
    return userRatingOverrides[id] ?? 0;
  }, [type, item, userRatingOverrides]);

  const commitRatingByKind = useCallback((kind: 'song' | 'album' | 'artist', id: string, rating: number) => {
    if (kind === 'song') {
      applySongRating(id, rating);
      return;
    }
    if (kind === 'album' && type === 'album') {
      applyAlbumRating(item as SubsonicAlbum, rating);
      return;
    }
    if (kind === 'album' && type === 'multi-album') {
      const albums = item as SubsonicAlbum[];
      const compositeId = [...albums.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return;
      for (const a of albums) applyAlbumRating(a, rating);
      return;
    }
    if (kind === 'artist' && type === 'artist') {
      applyArtistRating(item as SubsonicArtist, rating);
      return;
    }
    if (kind === 'artist' && type === 'multi-artist') {
      const artists = item as SubsonicArtist[];
      const compositeId = [...artists.map(a => a.id)].sort().join('\x1e');
      if (id !== compositeId) return;
      for (const a of artists) applyArtistRating(a, rating);
    }
  }, [applySongRating, applyAlbumRating, applyArtistRating, type, item]);

  const { onMenuKeyDown } = useContextMenuKeyboardNav({
    menuRef,
    isOpen: contextMenu.isOpen,
    closeContextMenu,
    keyboardRating,
    setKeyboardRating,
    getRatingValueByKind,
    commitRatingByKind,
    playlistSubmenuOpen,
    setPlaylistSubmenuOpen,
    setPlaylistSongIds,
    pendingSubmenuKeyboardFocus,
    setPendingSubmenuKeyboardFocus,
  });

  const handleAction = async (action: () => void | Promise<void>) => {
    closeContextMenu();
    await action();
  };

  const copyShareLink = useCallback(
    (kind: EntityShareKind, id: string) => copyShareLinkAction(kind, id, t),
    [t],
  );

  const startRadio = (artistId: string, artistName: string, seedTrack?: Track) =>
    startRadioAction(artistId, artistName, playTrack, seedTrack);

  const startInstantMix = (song: Track) => startInstantMixAction(song, t);

  const downloadAlbum = downloadAlbumAction;

  if (!contextMenu.isOpen || !contextMenu.item) return null;

  return (
    <>
      <div
        ref={menuRef}
        className="context-menu animate-fade-in"
        style={{ left: coords.x, top: coords.y }}
        tabIndex={-1}
        onKeyDown={onMenuKeyDown}
      >
        {(type === 'song' || type === 'album-song') && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, [song]))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => playNext([song]))}>
                <ChevronsRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => enqueue([song]))}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              {orbitRole === 'guest' && (() => {
                const muted = evaluateOrbitSuggestGate().reason === 'muted';
                return (
                  <div
                    className={`context-menu-item${muted ? ' is-disabled' : ''}`}
                    {...(muted ? { 'data-tooltip': t('orbit.suggestBlockedMuted') } : {})}
                    onClick={() => handleAction(() => {
                      if (muted) { showToast(t('orbit.suggestBlockedMuted'), 3500, 'error'); return; }
                      suggestOrbitTrack(song.id)
                        .then(() => showToast(t('orbit.ctxSuggestedToast'), 2200, 'info'))
                        .catch(err => {
                          if (err instanceof OrbitSuggestBlockedError && err.reason === 'muted') {
                            showToast(t('orbit.suggestBlockedMuted'), 3500, 'error');
                          } else {
                            showToast(t('orbit.ctxSuggestFailed'), 3000, 'error');
                          }
                        });
                    })}
                  >
                    <OrbitIcon size={14} /> {t('orbit.ctxAddToSession')}
                  </div>
                );
              })()}
              {orbitRole === 'host' && (
                <div className="context-menu-item" onClick={() => handleAction(() => {
                  hostEnqueueToOrbit(song.id)
                    .then(() => showToast(t('orbit.ctxAddedHostToast'), 2200, 'info'))
                    .catch(() => showToast(t('orbit.ctxAddHostFailed'), 3000, 'error'));
                })}>
                  <OrbitIcon size={14} /> {t('orbit.ctxAddToSessionHost')}
                </div>
              )}
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === song.id ? 'active' : ''}`}
                data-playlist-trigger-id={song.id}
                onMouseEnter={() => { setPlaylistSongIds([song.id]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === song.id && (
                  <AddToPlaylistSubmenu songIds={[song.id]} triggerId={song.id} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
             {type === 'album-song' && (
                 <div className="context-menu-item" onClick={() => handleAction(async () => {
                   const albumData = await getAlbum(song.albumId);
                   const tracks = albumData.songs.map(songToTrack);
                   enqueue(tracks);
                 })}>
                  <ListPlus size={14} /> {t('contextMenu.enqueueAlbum')}
                </div>
              )}
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${song.albumId}`))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${song.artistId}`))}>
                  <User size={14} /> {t('contextMenu.goToArtist')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artistId ?? song.artist, song.artist, song))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {audiomuseNavidromeEnabled && (
                <div className="context-menu-item" onClick={() => handleAction(() => startInstantMix(song))}>
                  <Sparkles size={14} /> {t('contextMenu.instantMix')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(song.id, song.starred);
                setStarredOverride(song.id, !starred);
                return starred ? unstar(song.id, 'song') : star(song.id, 'song');
              })}>
                <Heart size={14} fill={isStarred(song.id, song.starred) ? 'currentColor' : 'none'} />
                {isStarred(song.id, song.starred) ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              </div>
              {auth.lastfmSessionKey && (() => {
                const loveKey = `${song.title}::${song.artist}`;
                const loved = lastfmLovedCache[loveKey] ?? false;
                return (
                  <div className="context-menu-item" onClick={() => handleAction(() => {
                    const newLoved = !loved;
                    setLastfmLovedForSong(song.title, song.artist, newLoved);
                    if (newLoved) lastfmLoveTrack(song, auth.lastfmSessionKey);
                    else lastfmUnloveTrack(song, auth.lastfmSessionKey);
                  })}>
                    <LastfmIcon size={14} />
                    {loved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
                  </div>
                );
              })()}
              <div
                className="context-menu-rating-row"
                data-rating-kind="song"
                data-rating-id={song.id}
                data-rating-disabled="false"
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'song' && keyboardRating.id === song.id
                    ? keyboardRating.value
                    : userRatingOverrides[song.id] ?? song.userRating ?? 0}
                  onChange={r => { setKeyboardRating({ kind: 'song', id: song.id, value: r }); applySongRating(song.id, r); }}
                  ariaLabel={t('albumDetail.ratingLabel')}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
              {playlistId && playlistSongIndex !== undefined && (
                <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                  const { getPlaylist, updatePlaylist } = await import('../api/subsonicPlaylists');
                  const { showToast } = await import('../utils/toast');
                  const touchPlaylist = usePlaylistStore.getState().touchPlaylist;
                  try {
                    const { songs } = await getPlaylist(playlistId);
                    const prevCount = songs.length;
                    const updatedIds = songs.filter((_, i) => i !== playlistSongIndex).map(s => s.id);
                    await updatePlaylist(playlistId, updatedIds, prevCount);
                    touchPlaylist(playlistId);
                    showToast(t('playlists.removeSuccess'), 3000, 'info');
                  } catch {
                    showToast(t('playlists.removeError'), 4000, 'error');
                  }
                })}>
                  <Trash2 size={14} /> {t('contextMenu.removeFromPlaylist')}
                </div>
              )}
            </>
          );
        })()}

        {type === 'favorite-song' && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, [song]))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => playNext([song]))}>
                <ChevronsRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => enqueue([song]))}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              {orbitRole === 'guest' && (() => {
                const muted = evaluateOrbitSuggestGate().reason === 'muted';
                return (
                  <div
                    className={`context-menu-item${muted ? ' is-disabled' : ''}`}
                    {...(muted ? { 'data-tooltip': t('orbit.suggestBlockedMuted') } : {})}
                    onClick={() => handleAction(() => {
                      if (muted) { showToast(t('orbit.suggestBlockedMuted'), 3500, 'error'); return; }
                      suggestOrbitTrack(song.id)
                        .then(() => showToast(t('orbit.ctxSuggestedToast'), 2200, 'info'))
                        .catch(err => {
                          if (err instanceof OrbitSuggestBlockedError && err.reason === 'muted') {
                            showToast(t('orbit.suggestBlockedMuted'), 3500, 'error');
                          } else {
                            showToast(t('orbit.ctxSuggestFailed'), 3000, 'error');
                          }
                        });
                    })}
                  >
                    <OrbitIcon size={14} /> {t('orbit.ctxAddToSession')}
                  </div>
                );
              })()}
              {orbitRole === 'host' && (
                <div className="context-menu-item" onClick={() => handleAction(() => {
                  hostEnqueueToOrbit(song.id)
                    .then(() => showToast(t('orbit.ctxAddedHostToast'), 2200, 'info'))
                    .catch(() => showToast(t('orbit.ctxAddHostFailed'), 3000, 'error'));
                })}>
                  <OrbitIcon size={14} /> {t('orbit.ctxAddToSessionHost')}
                </div>
              )}
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === song.id ? 'active' : ''}`}
                data-playlist-trigger-id={song.id}
                onMouseEnter={() => { setPlaylistSongIds([song.id]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === song.id && (
                  <AddToPlaylistSubmenu songIds={[song.id]} triggerId={song.id} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${song.albumId}`))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${song.artistId}`))}>
                  <User size={14} /> {t('contextMenu.goToArtist')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artistId ?? song.artist, song.artist, song))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {audiomuseNavidromeEnabled && (
                <div className="context-menu-item" onClick={() => handleAction(() => startInstantMix(song))}>
                  <Sparkles size={14} /> {t('contextMenu.instantMix')}
                </div>
              )}
              {auth.lastfmSessionKey && (() => {
                const loveKey = `${song.title}::${song.artist}`;
                const loved = lastfmLovedCache[loveKey] ?? false;
                return (
                  <div className="context-menu-item" onClick={() => handleAction(() => {
                    const newLoved = !loved;
                    setLastfmLovedForSong(song.title, song.artist, newLoved);
                    if (newLoved) lastfmLoveTrack(song, auth.lastfmSessionKey);
                    else lastfmUnloveTrack(song, auth.lastfmSessionKey);
                  })}>
                    <LastfmIcon size={14} />
                    {loved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
                  </div>
                );
              })()}
              <div
                className="context-menu-rating-row"
                data-rating-kind="song"
                data-rating-id={song.id}
                data-rating-disabled="false"
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'song' && keyboardRating.id === song.id
                    ? keyboardRating.value
                    : userRatingOverrides[song.id] ?? song.userRating ?? 0}
                  onChange={r => { setKeyboardRating({ kind: 'song', id: song.id, value: r }); applySongRating(song.id, r); }}
                  ariaLabel={t('albumDetail.ratingLabel')}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(() => {
                setStarredOverride(song.id, false);
                return unstar(song.id, 'song');
              })}>
                <HeartCrack size={14} /> {t('contextMenu.unfavorite')}
              </div>
            </>
          );
        })()}

        {type === 'album' && (() => {
          const album = item as SubsonicAlbum;
          const albumRatingDisabled = entityRatingSupport === 'track_only';
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${album.id}`))}>
                <Play size={14} /> {t('contextMenu.openAlbum')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const albumData = await getAlbum(album.id);
                const tracks = albumData.songs.map(songToTrack);
                if (tracks.length === 0) return;
                playNext(tracks);
              })}>
                <ChevronsRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const albumData = await getAlbum(album.id);
                enqueue(albumData.songs.map(songToTrack));
              })}>
                <ListPlus size={14} /> {t('contextMenu.enqueueAlbum')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${album.artistId}`))}>
                <User size={14} /> {t('contextMenu.goToArtist')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(album.id, album.starred);
                setStarredOverride(album.id, !starred);
                return starred ? unstar(album.id, 'album') : star(album.id, 'album');
              })}>
                <Heart size={14} fill={isStarred(album.id, album.starred) ? 'currentColor' : 'none'} />
                {isStarred(album.id, album.starred) ? t('contextMenu.unfavoriteAlbum') : t('contextMenu.favoriteAlbum')}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="album"
                data-rating-id={album.id}
                data-rating-disabled={albumRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'album' && keyboardRating.id === album.id
                    ? keyboardRating.value
                    : userRatingOverrides[album.id] ?? album.userRating ?? 0}
                  disabled={albumRatingDisabled}
                  labelKey="entityRating.albumAriaLabel"
                  onChange={r => { setKeyboardRating({ kind: 'album', id: album.id, value: r }); applyAlbumRating(album, r); }}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('album', album.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => downloadAlbum(album.name, album.id))}>
                <Download size={14} /> {t('contextMenu.download')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `album:${album.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`album:${album.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`album:${album.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `album:${album.id}` && (
                  <AlbumToPlaylistSubmenu albumId={album.id} triggerId={`album:${album.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
            </>
          );
        })()}

        {type === 'playlist' && (() => {
          const playlist = item as SubsonicPlaylist;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/playlists/${playlist.id}`))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-divider" />
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`playlist:${playlist.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`playlist:${playlist.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` && (
                  <SinglePlaylistToPlaylistSubmenu playlist={playlist} triggerId={`playlist:${playlist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('../utils/toast');
                const { deletePlaylist } = await import('../api/subsonicPlaylists');
                const { removeId } = usePlaylistStore.getState();
                try {
                  await deletePlaylist(playlist.id);
                  removeId(playlist.id);
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => p.id !== playlist.id),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: 1 }), 3000, 'info');
                } catch {
                  showToast(t('playlists.deleteFailed', { name: playlist.name }), 3000, 'error');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deletePlaylist')}
              </div>
            </>
          );
        })()}

        {type === 'multi-album' && (() => {
          const albums = item as SubsonicAlbum[];
          const albumIds = albums.map(a => a.id);
          const albumRatingDisabled = entityRatingSupport === 'track_only';
          const multiAlbumRatingId = [...albumIds].sort().join('\x1e');
          const unifiedAlbumRating = (() => {
            if (albums.length === 0) return 0;
            const vals = albums.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
            const first = vals[0];
            return vals.every(v => v === first) ? first : 0;
          })();
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedAlbums', { count: albums.length })}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                // Parallel — Navidrome handles concurrent getAlbum requests fine.
                const results = await Promise.all(albums.map(a => getAlbum(a.id)));
                const allTracks = results.flatMap(r => r.songs.map(songToTrack));
                enqueue(allTracks);
              })}>
                <ListPlus size={14} /> {t('contextMenu.enqueueAlbums', { count: albums.length })}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-album:${albumIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-album:${albumIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-album:${albumIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-album:${albumIds.join(',')}` && (
                  <MultiAlbumToPlaylistSubmenu albumIds={albumIds} triggerId={`multi-album:${albumIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="album"
                data-rating-id={multiAlbumRatingId}
                data-rating-disabled={albumRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={
                    keyboardRating?.kind === 'album' && keyboardRating.id === multiAlbumRatingId
                      ? keyboardRating.value
                      : unifiedAlbumRating
                  }
                  disabled={albumRatingDisabled}
                  ariaLabel={t('entityRating.selectedAlbumsRatingAriaLabel', { count: albums.length })}
                  onChange={r => {
                    setKeyboardRating({ kind: 'album', id: multiAlbumRatingId, value: r });
                    for (const a of albums) applyAlbumRating(a, r);
                  }}
                />
              </div>
            </>
          );
        })()}

        {type === 'artist' && (() => {
          const artist = item as SubsonicArtist;
          const artistRatingDisabled = entityRatingSupport === 'track_only';
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(artist.id, artist.name))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `artist:${artist.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`artist:${artist.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`artist:${artist.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `artist:${artist.id}` && (
                  <ArtistToPlaylistSubmenu artistId={artist.id} triggerId={`artist:${artist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink(shareKindOverride ?? 'artist', artist.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(artist.id, artist.starred);
                setStarredOverride(artist.id, !starred);
                return starred ? unstar(artist.id, 'artist') : star(artist.id, 'artist');
              })}>
                <Heart size={14} fill={isStarred(artist.id, artist.starred) ? 'currentColor' : 'none'} />
                {isStarred(artist.id, artist.starred) ? t('contextMenu.unfavoriteArtist') : t('contextMenu.favoriteArtist')}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="artist"
                data-rating-id={artist.id}
                data-rating-disabled={artistRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'artist' && keyboardRating.id === artist.id
                    ? keyboardRating.value
                    : userRatingOverrides[artist.id] ?? artist.userRating ?? 0}
                  disabled={artistRatingDisabled}
                  labelKey="entityRating.artistAriaLabel"
                  onChange={r => { setKeyboardRating({ kind: 'artist', id: artist.id, value: r }); applyArtistRating(artist, r); }}
                />
              </div>
            </>
          );
        })()}

        {type === 'multi-artist' && (() => {
          const artists = item as SubsonicArtist[];
          const artistIds = artists.map(a => a.id);
          const artistRatingDisabled = entityRatingSupport === 'track_only';
          const multiArtistRatingId = [...artistIds].sort().join('\x1e');
          const unifiedArtistRating = (() => {
            if (artists.length === 0) return 0;
            const vals = artists.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
            const first = vals[0];
            return vals.every(v => v === first) ? first : 0;
          })();
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedArtists', { count: artists.length })}
              </div>
              <div className="context-menu-divider" />
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-artist:${artistIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-artist:${artistIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-artist:${artistIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-artist:${artistIds.join(',')}` && (
                  <MultiArtistToPlaylistSubmenu artistIds={artistIds} triggerId={`multi-artist:${artistIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="artist"
                data-rating-id={multiArtistRatingId}
                data-rating-disabled={artistRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={
                    keyboardRating?.kind === 'artist' && keyboardRating.id === multiArtistRatingId
                      ? keyboardRating.value
                      : unifiedArtistRating
                  }
                  disabled={artistRatingDisabled}
                  ariaLabel={t('entityRating.selectedArtistsRatingAriaLabel', { count: artists.length })}
                  onChange={r => {
                    setKeyboardRating({ kind: 'artist', id: multiArtistRatingId, value: r });
                    for (const a of artists) applyArtistRating(a, r);
                  }}
                />
              </div>
            </>
          );
        })()}

        {type === 'multi-playlist' && (() => {
          const selectedPlaylists = item as SubsonicPlaylist[];
          const playlistIds = selectedPlaylists.map(p => p.id);
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedPlaylists', { count: selectedPlaylists.length })}
              </div>
              <div className="context-menu-divider" />
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-playlist:${playlistIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-playlist:${playlistIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` && (
                  <MultiPlaylistToPlaylistSubmenu playlists={selectedPlaylists} triggerId={`multi-playlist:${playlistIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('../utils/toast');
                const { deletePlaylist } = await import('../api/subsonicPlaylists');
                const { removeId } = usePlaylistStore.getState();
                const deletedIds: string[] = [];
                for (const pl of selectedPlaylists) {
                  try {
                    await deletePlaylist(pl.id);
                    removeId(pl.id);
                    deletedIds.push(pl.id);
                  } catch {
                    showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
                  }
                }
                if (deletedIds.length > 0) {
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => !deletedIds.includes(p.id)),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: deletedIds.length }), 3000, 'info');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deleteSelected')}
              </div>
            </>
          );
        })()}

        {type === 'queue-item' && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, queue, undefined, undefined, contextMenu.queueIndex))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(() => {
                if (queueIndex !== undefined) removeTrack(queueIndex);
              })}>
                <Trash2 size={14} /> {t('contextMenu.removeFromQueue')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === song.id ? 'active' : ''}`}
                data-playlist-trigger-id={song.id}
                onMouseEnter={() => { setPlaylistSongIds([song.id]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === song.id && (
                  <AddToPlaylistSubmenu songIds={[song.id]} triggerId={song.id} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${song.albumId}`))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${song.artistId}`))}>
                  <User size={14} /> {t('contextMenu.goToArtist')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artistId ?? song.artist, song.artist, song))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {audiomuseNavidromeEnabled && (
                <div className="context-menu-item" onClick={() => handleAction(() => startInstantMix(song))}>
                  <Sparkles size={14} /> {t('contextMenu.instantMix')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(song.id, song.starred);
                setStarredOverride(song.id, !starred);
                return starred ? unstar(song.id, 'song') : star(song.id, 'song');
              })}>
                <Heart size={14} fill={isStarred(song.id, song.starred) ? 'currentColor' : 'none'} />
                {isStarred(song.id, song.starred) ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              </div>
              {auth.lastfmSessionKey && (() => {
                const loveKey = `${song.title}::${song.artist}`;
                const loved = lastfmLovedCache[loveKey] ?? false;
                return (
                  <div className="context-menu-item" onClick={() => handleAction(() => {
                    const newLoved = !loved;
                    setLastfmLovedForSong(song.title, song.artist, newLoved);
                    if (newLoved) lastfmLoveTrack(song, auth.lastfmSessionKey);
                    else lastfmUnloveTrack(song, auth.lastfmSessionKey);
                  })}>
                    <LastfmIcon size={14} />
                    {loved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
                  </div>
                );
              })()}
              <div
                className="context-menu-rating-row"
                data-rating-kind="song"
                data-rating-id={song.id}
                data-rating-disabled="false"
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'song' && keyboardRating.id === song.id
                    ? keyboardRating.value
                    : userRatingOverrides[song.id] ?? song.userRating ?? 0}
                  onChange={r => { setKeyboardRating({ kind: 'song', id: song.id, value: r }); applySongRating(song.id, r); }}
                  ariaLabel={t('albumDetail.ratingLabel')}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
            </>
          );
        })()}
      </div>
    </>
  );
}
