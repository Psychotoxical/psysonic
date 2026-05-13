import { getPlaylists, getPlaylist, updatePlaylist } from '../api/subsonicPlaylists';
import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { star, unstar, setRating } from '../api/subsonicStarRating';
import { getAlbum } from '../api/subsonicLibrary';
import { getSimilarSongs2, getSimilarSongs, getTopSongs, getArtist } from '../api/subsonicArtists';
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
import { useDownloadModalStore } from '../store/downloadModalStore';
import { usePlaylistStore } from '../store/playlistStore';
import { open } from '@tauri-apps/plugin-shell';
import { join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import type { EntityShareKind } from '../utils/shareLink';
import { copyEntityShareLink } from '../utils/copyEntityShareLink';
import {
  SMART_PLAYLIST_PREFIX,
  confirmAddAllDuplicates,
  isSmartPlaylistName,
  sanitizeFilename,
  shuffleArray,
} from '../utils/contextMenuHelpers';
import { AddToPlaylistSubmenu } from './contextMenu/AddToPlaylistSubmenu';
import { AlbumToPlaylistSubmenu, ArtistToPlaylistSubmenu } from './contextMenu/AlbumArtistToPlaylistSubmenu';
import { MultiAlbumToPlaylistSubmenu } from './contextMenu/MultiAlbumToPlaylistSubmenu';
import { MultiArtistToPlaylistSubmenu } from './contextMenu/MultiArtistToPlaylistSubmenu';
import {
  MultiPlaylistToPlaylistSubmenu,
  SinglePlaylistToPlaylistSubmenu,
} from './contextMenu/PlaylistToPlaylistSubmenus';

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
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
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

  const getMenuNavItems = useCallback(
    (scope: 'main' | 'submenu' = 'main') => {
      if (!menuRef.current) return [];
      if (scope === 'submenu') {
        const sub = menuRef.current.querySelector<HTMLElement>('.context-submenu');
        if (!sub || sub.offsetParent === null) return [];
        return Array.from(
          sub.querySelectorAll<HTMLElement>('.context-menu-item, .context-submenu-create-btn'),
        ).filter(el => el.offsetParent !== null);
      }
      return Array.from(menuRef.current.children)
        .filter((el): el is HTMLElement =>
          el instanceof HTMLElement &&
          (el.classList.contains('context-menu-item') || el.classList.contains('context-menu-rating-row')) &&
          el.offsetParent !== null,
        );
    },
    [],
  );

  const focusMenuItemAt = useCallback((scope: 'main' | 'submenu', index: number) => {
    const items = getMenuNavItems(scope);
    if (items.length === 0) return;
    menuRef.current
      ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
      .forEach(el => el.classList.remove('context-menu-keyboard-active'));
    const safeIdx = ((index % items.length) + items.length) % items.length;
    const target = items[safeIdx];
    target.classList.add('context-menu-keyboard-active');
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  }, [getMenuNavItems]);

  useEffect(() => {
    if (!contextMenu.isOpen) return;
    requestAnimationFrame(() => {
      menuRef.current?.focus({ preventScroll: true });
      // Do not pre-highlight any menu row; keyboard outline appears only
      // after explicit arrow navigation.
    });
  }, [contextMenu.isOpen]);

  // Outside-click closes the menu without occluding the underlying UI. The
  // previous implementation rendered a transparent fullscreen backdrop, which
  // also blocked right-clicks from reaching elements *under* it — so users
  // couldn't reposition the menu by right-clicking another row.
  useEffect(() => {
    if (!contextMenu.isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      closeContextMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu.isOpen, closeContextMenu]);

  useEffect(() => {
    if (!pendingSubmenuKeyboardFocus || !playlistSubmenuOpen) return;
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      const items = getMenuNavItems('submenu');
      if (items.length > 0) {
        focusMenuItemAt('submenu', 0);
        setPendingSubmenuKeyboardFocus(false);
        return;
      }
      if (attemptsLeft <= 0) {
        setPendingSubmenuKeyboardFocus(false);
        return;
      }
      requestAnimationFrame(() => tryFocus(attemptsLeft - 1));
    };
    requestAnimationFrame(() => tryFocus(8));
    return () => {
      cancelled = true;
    };
  }, [pendingSubmenuKeyboardFocus, playlistSubmenuOpen, getMenuNavItems, focusMenuItemAt]);

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

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement as HTMLElement | null;
    const ratingRow = active?.closest('.context-menu-rating-row') as HTMLElement | null;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (ratingRow) {
        const kind = ratingRow.dataset.ratingKind as ('song' | 'album' | 'artist' | undefined);
        const id = ratingRow.dataset.ratingId;
        if (!kind || !id) return;
        if (ratingRow.dataset.ratingDisabled === 'true') return;
        const value = keyboardRating && keyboardRating.kind === kind && keyboardRating.id === id
          ? keyboardRating.value
          : getRatingValueByKind(kind, id);
        commitRatingByKind(kind, id, value);
        setKeyboardRating({ kind, id, value });
        return;
      }
      active?.click();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (ratingRow) {
        const kind = ratingRow.dataset.ratingKind as ('song' | 'album' | 'artist' | undefined);
        const id = ratingRow.dataset.ratingId;
        if (!kind || !id) return;
        if (ratingRow.dataset.ratingDisabled === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        const currentValue = keyboardRating && keyboardRating.kind === kind && keyboardRating.id === id
          ? keyboardRating.value
          : getRatingValueByKind(kind, id);
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const nextValue = Math.max(0, Math.min(5, currentValue + delta));
        setKeyboardRating({ kind, id, value: nextValue });
        return;
      }
    }
    if (e.key === 'ArrowRight') {
      const trigger = active?.closest('.context-menu-item--submenu') as HTMLElement | null;
      const triggerId = trigger?.dataset.playlistTriggerId;
      if (!trigger || !triggerId) return;
      e.preventDefault();
      e.stopPropagation();
      setPlaylistSongIds([triggerId]);
      setPlaylistSubmenuOpen(true);
      setPendingSubmenuKeyboardFocus(true);
      return;
    }
    if (e.key === 'ArrowLeft') {
      const sub = active?.closest('.context-submenu') as HTMLElement | null;
      if (!sub) return;
      e.preventDefault();
      e.stopPropagation();
      const triggerId = sub.dataset.parentTriggerId;
      setPlaylistSubmenuOpen(false);
      requestAnimationFrame(() => {
        const trigger = triggerId
          ? Array.from(menuRef.current?.querySelectorAll<HTMLElement>('.context-menu-item--submenu') ?? [])
              .find(el => el.dataset.playlistTriggerId === triggerId) ?? null
          : null;
        if (trigger) {
          menuRef.current
            ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
            .forEach(el => el.classList.remove('context-menu-keyboard-active'));
          trigger.classList.add('context-menu-keyboard-active');
          trigger.focus({ preventScroll: true });
        }
      });
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const scope: 'main' | 'submenu' = active?.closest('.context-submenu') ? 'submenu' : 'main';
    const items = getMenuNavItems(scope);
    if (items.length === 0) return;
    const activeIdx = items.findIndex(el => el === document.activeElement);
    const nextIdx =
      activeIdx >= 0
        ? (e.key === 'ArrowDown' ? activeIdx + 1 : activeIdx - 1)
        : (e.key === 'ArrowDown' ? 0 : items.length - 1);
    focusMenuItemAt(scope, nextIdx);
  }, [closeContextMenu, keyboardRating, getRatingValueByKind, commitRatingByKind, getMenuNavItems, focusMenuItemAt]);

  const handleAction = async (action: () => void | Promise<void>) => {
    closeContextMenu();
    await action();
  };

  const copyShareLink = useCallback(async (kind: EntityShareKind, id: string) => {
    const ok = await copyEntityShareLink(kind, id);
    if (ok) showToast(t('contextMenu.shareCopied'));
    else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
  }, [t]);

  const startRadio = async (artistId: string, artistName: string, seedTrack?: Track) => {
    if (seedTrack) {
      // Start playback immediately based on current state
      const state = usePlayerStore.getState();
      if (state.currentTrack?.id === seedTrack.id) {
        if (!state.isPlaying) state.resume();
        // Already playing this track — don't restart
      } else {
        playTrack(seedTrack, [seedTrack]);
      }
      // Load radio queue in background — enqueueRadio replaces any pending radio
      // tracks so clicking "Start Radio" again never stacks duplicate batches.
      // Lead with similar songs (other artists) so the listener doesn't get a
      // wall of the seed artist's own top tracks before anything else plays.
      // Top tracks stay as a fallback for setups without Last.fm / small
      // libraries where similar comes back empty (issue #500).
      try {
        const [similar, top] = await Promise.all([getSimilarSongs2(artistId), getTopSongs(artistName)]);
        const similarTracks = shuffleArray(
          similar.map(songToTrack).filter(t => t.id !== seedTrack.id).map(t => ({ ...t, radioAdded: true as const }))
        );
        const radioTracks = similarTracks.length > 0
          ? similarTracks
          : shuffleArray(
              top.map(songToTrack).filter(t => t.id !== seedTrack.id).map(t => ({ ...t, radioAdded: true as const }))
            );
        if (radioTracks.length > 0) usePlayerStore.getState().enqueueRadio(radioTracks, artistId);
      } catch (e) {
        console.error('Failed to load radio queue', e);
      }
    } else {
      // Artist radio: fire both calls immediately but don't wait for the slow one.
      // getTopSongs is fast (local library) — start playback as soon as it resolves.
      // getSimilarSongs2 is slow (Last.fm) — enrich the queue in the background.
      const similarPromise = getSimilarSongs2(artistId).catch(() => [] as Awaited<ReturnType<typeof getSimilarSongs2>>);
      try {
        const top = await getTopSongs(artistName);
        // Shuffle so each Radio session starts from a different track rather
        // than always kicking off with the #1 most-played song.
        const topTracks = shuffleArray(
          top.map(t => ({ ...songToTrack(t), radioAdded: true as const }))
        );
        if (topTracks.length === 0) {
          // No local top songs — fall back to waiting for similar tracks
          const similar = await similarPromise;
          const fallback = shuffleArray(
            similar.map(t => ({ ...songToTrack(t), radioAdded: true as const }))
          );
          if (fallback.length === 0) return;
          const state = usePlayerStore.getState();
          if (state.currentTrack) {
            state.enqueueRadio(fallback, artistId);
          } else {
            state.setRadioArtistId(artistId);
            playTrack(fallback[0], fallback);
          }
          return;
        }
        // Start playback from the first shuffled top track only.
        // No other tracks are queued yet — positions 2+ will be filled
        // exclusively by the similar-songs result below.
        const state = usePlayerStore.getState();
        if (state.currentTrack) {
          state.enqueueRadio([topTracks[0]], artistId);
        } else {
          state.setRadioArtistId(artistId);
          playTrack(topTracks[0], [topTracks[0]]);
        }
        // Populate positions 2+ from similar songs only — never from the
        // remaining top tracks.  Mixing in topTracks.slice(1) meant that when
        // getSimilarSongs2 returned nothing (no Last.fm, small library, etc.)
        // the queue fell back to the same top-4 the user just heard.
        // If similarTracks is also empty, the proactive top-up in next()
        // will refill the queue when the first track nears its end.
        similarPromise.then(similar => {
          const similarTracks = shuffleArray(
            similar
              .map(t => ({ ...songToTrack(t), radioAdded: true as const }))
              .filter(t => t.id !== topTracks[0].id)
          );
          if (similarTracks.length === 0) return;
          const { queue, queueIndex } = usePlayerStore.getState();
          const pendingRadio = queue.slice(queueIndex + 1).filter(t => t.radioAdded);
          usePlayerStore.getState().enqueueRadio([...pendingRadio, ...similarTracks], artistId);
        });
      } catch (e) {
        console.error('Failed to start radio', e);
      }
    }
  };

  const startInstantMix = async (song: Track) => {
    usePlayerStore.getState().reseedQueueForInstantMix(song);
    const serverId = useAuthStore.getState().activeServerId;
    try {
      const similar = await getSimilarSongs(song.id, 50);
      if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, false);
      const shuffled = shuffleArray(
        similar
          .filter(s => s.id !== song.id)
          .map(s => ({ ...songToTrack(s), radioAdded: true as const }))
      );
      if (shuffled.length > 0) {
        const aid = song.artistId?.trim() || undefined;
        usePlayerStore.getState().enqueueRadio(shuffled, aid);
      }
    } catch (e) {
      console.error('Instant mix failed', e);
      if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, true);
      showToast(t('contextMenu.instantMixFailed'), 5000, 'error');
    }
  };

  const downloadAlbum = async (albumName: string, albumId: string) => {
    const folder = auth.downloadFolder || await requestDownloadFolder();
    if (!folder) return;

    const filename = `${sanitizeFilename(albumName)}.zip`;
    const destPath = await join(folder, filename);
    const url = buildDownloadUrl(albumId);
    const id = crypto.randomUUID();

    const { start, complete, fail } = useZipDownloadStore.getState();
    start(id, filename);
    try {
      await invoke('download_zip', { id, url, destPath });
      complete(id);
    } catch (e) {
      fail(id);
      console.error('ZIP download failed:', e);
    }
  };

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
