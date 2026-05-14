import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '../store/playerStoreTypes';
import { useOrbitStore } from '../store/orbitStore';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import type { EntityShareKind } from '../utils/share/shareLink';
import { AddToPlaylistSubmenu } from './contextMenu/AddToPlaylistSubmenu';
import {
  copyShareLink as copyShareLinkAction,
  downloadAlbum as downloadAlbumAction,
  startInstantMix as startInstantMixAction,
  startRadio as startRadioAction,
} from '../utils/componentHelpers/contextMenuActions';
import { useContextMenuKeyboardNav } from '../hooks/useContextMenuKeyboardNav';
import { useContextMenuRating } from '../hooks/useContextMenuRating';
import ContextMenuItems from './contextMenu/ContextMenuItems';

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
  const entityRatingSupport =
    auth.activeServerId ? auth.entityRatingSupportByServer[auth.activeServerId] ?? 'unknown' : 'unknown';
  const audiomuseNavidromeEnabled = !!(auth.activeServerId && auth.audiomuseNavidromeByServer[auth.activeServerId]);
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

  const { applySongRating, applyAlbumRating, applyArtistRating, getRatingValueByKind, commitRatingByKind } =
    useContextMenuRating({ type, item, userRatingOverrides, setUserRatingOverride, entityRatingSupport, t });

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
        <ContextMenuItems
          type={type}
          item={item}
          queueIndex={queueIndex}
          playlistId={playlistId}
          playlistSongIndex={playlistSongIndex}
          shareKindOverride={shareKindOverride}
          playTrack={playTrack}
          playNext={playNext}
          enqueue={enqueue}
          removeTrack={removeTrack}
          queue={queue}
          currentTrack={currentTrack}
          closeContextMenu={closeContextMenu}
          starredOverrides={starredOverrides}
          setStarredOverride={setStarredOverride}
          lastfmLovedCache={lastfmLovedCache}
          setLastfmLovedForSong={setLastfmLovedForSong}
          openSongInfo={openSongInfo}
          userRatingOverrides={userRatingOverrides}
          setKeyboardRating={setKeyboardRating}
          keyboardRating={keyboardRating}
          playlistSubmenuOpen={playlistSubmenuOpen}
          setPlaylistSubmenuOpen={setPlaylistSubmenuOpen}
          playlistSongIds={playlistSongIds}
          setPlaylistSongIds={setPlaylistSongIds}
          orbitRole={orbitRole}
          entityRatingSupport={entityRatingSupport}
          audiomuseNavidromeEnabled={audiomuseNavidromeEnabled}
          applySongRating={applySongRating}
          applyAlbumRating={applyAlbumRating}
          applyArtistRating={applyArtistRating}
          handleAction={handleAction}
          startRadio={startRadio}
          startInstantMix={startInstantMix}
          downloadAlbum={downloadAlbum}
          copyShareLink={copyShareLink}
          isStarred={isStarred}
        />
      </div>
    </>
  );
}
