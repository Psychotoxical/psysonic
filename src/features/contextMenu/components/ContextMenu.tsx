import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '@/lib/media/trackTypes';
import { useOrbitStore } from '@/features/orbit';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import type { EntityShareKind } from '@/lib/share/shareLink';
import { AddToPlaylistSubmenu } from '@/features/contextMenu/components/AddToPlaylistSubmenu';
import {
  copyShareLink as copyShareLinkAction,
  downloadAlbum as downloadAlbumAction,
  startInstantMix as startInstantMixAction,
  startRadio as startRadioAction,
} from '@/features/contextMenu/utils/contextMenuActions';
import { useContextMenuKeyboardNav } from '@/features/contextMenu/hooks/useContextMenuKeyboardNav';
import { useContextMenuRating } from '@/features/contextMenu/hooks/useContextMenuRating';
import { usePlaybackLibraryNavigate } from '@/features/playback/hooks/usePlaybackLibraryNavigate';
import { useNavigate } from 'react-router-dom';
import { useOfflineBrowseContext } from '@/features/offline';
import {
  offlineActionPolicy,
  type OfflineSurface,
} from '@/features/offline';
import ContextMenuItems from '@/features/contextMenu/components/ContextMenuItems';

function contextMenuSurfaceForType(type: string | null): OfflineSurface {
  switch (type) {
    case 'album':
    case 'multi-album':
      return 'contextMenuAlbum';
    case 'artist':
    case 'multi-artist':
      return 'contextMenuArtist';
    case 'playlist':
    case 'multi-playlist':
      return 'contextMenuPlaylist';
    default:
      return 'contextMenuSong';
  }
}

export { AddToPlaylistSubmenu };


export default function ContextMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigatePlaybackLibrary = usePlaybackLibraryNavigate();
  const orbitRole = useOrbitStore(s => s.role);
  const { contextMenu, closeContextMenu, playTrack, enqueue, playNext, queueItems, currentTrack, removeTrack, networkLovedCache, setNetworkLovedForSong, starredOverrides, setStarredOverride, openSongInfo, userRatingOverrides, setUserRatingOverride } = usePlayerStore(
    useShallow(s => ({
      contextMenu: s.contextMenu,
      closeContextMenu: s.closeContextMenu,
      playTrack: s.playTrack,
      enqueue: s.enqueue,
      playNext: s.playNext,
      queueItems: s.queueItems,
      currentTrack: s.currentTrack,
      removeTrack: s.removeTrack,
      networkLovedCache: s.networkLovedCache,
      setNetworkLovedForSong: s.setNetworkLovedForSong,
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

  const playlistSubmenuCloseTimerRef = useRef<number | null>(null);

  const cancelPlaylistSubmenuCloseTimer = useCallback(() => {
    if (playlistSubmenuCloseTimerRef.current != null) {
      window.clearTimeout(playlistSubmenuCloseTimerRef.current);
      playlistSubmenuCloseTimerRef.current = null;
    }
  }, []);

  /** Delay close so a slow move across subpixel / border seams still lands on `.context-submenu` (a child of the row). */
  const onPlaylistSubmenuTriggerMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const cur = e.currentTarget;
      const next = e.relatedTarget;
      if (next instanceof Node && cur.contains(next)) return;
      cancelPlaylistSubmenuCloseTimer();
      playlistSubmenuCloseTimerRef.current = window.setTimeout(() => {
        playlistSubmenuCloseTimerRef.current = null;
        if (!cur.isConnected) return;
        if (!cur.matches(':hover')) setPlaylistSubmenuOpen(false);
      }, 140);
    },
    [cancelPlaylistSubmenuCloseTimer],
  );

  useEffect(() => {
    if (contextMenu.isOpen) {
      cancelPlaylistSubmenuCloseTimer();
      // React Compiler set-state-in-effect rule: local coords synced from the store's contextMenu position when the menu opens.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCoords({ x: contextMenu.x, y: contextMenu.y });
      setPlaylistSubmenuOpen(false);
      setPlaylistSongIds([]);
      setKeyboardRating(null);
      setPendingSubmenuKeyboardFocus(false);
    }
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y, cancelPlaylistSubmenuCloseTimer]);

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

  // Close on any window resize. The menu is absolutely positioned at fixed
  // coordinates, so a resize would otherwise leave it stranded and drifting
  // off-screen. Whether a resize closed the menu was inconsistent across
  // setups (it stayed open on some Windows and Linux environments); always
  // closing it here makes the behaviour the same everywhere.
  useEffect(() => {
    if (!contextMenu.isOpen) return;
    const onResize = () => closeContextMenu();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [contextMenu.isOpen, closeContextMenu]);

  useEffect(() => {
    if (contextMenu.isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    cancelPlaylistSubmenuCloseTimer();
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
  }, [contextMenu.isOpen, closeContextMenu, cancelPlaylistSubmenuCloseTimer]);


  const {
    type,
    item,
    queueIndex,
    playlistId,
    playlistSongIndex,
    shareKindOverride,
    pinToPlaybackServer = false,
  } = contextMenu;
  const navigateLibrary = pinToPlaybackServer
    ? navigatePlaybackLibrary
    : (path: string) => { navigate(path); };

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

  const { active: offlineBrowseActive } = useOfflineBrowseContext();
  const offlinePolicy = offlineActionPolicy(
    contextMenuSurfaceForType(type),
    offlineBrowseActive,
  );

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
          queue={queueItems}
          currentTrack={currentTrack}
          closeContextMenu={closeContextMenu}
          starredOverrides={starredOverrides}
          setStarredOverride={setStarredOverride}
          networkLovedCache={networkLovedCache}
          setNetworkLovedForSong={setNetworkLovedForSong}
          openSongInfo={openSongInfo}
          userRatingOverrides={userRatingOverrides}
          setKeyboardRating={setKeyboardRating}
          keyboardRating={keyboardRating}
          playlistSubmenuOpen={playlistSubmenuOpen}
          setPlaylistSubmenuOpen={setPlaylistSubmenuOpen}
          cancelPlaylistSubmenuCloseTimer={cancelPlaylistSubmenuCloseTimer}
          onPlaylistSubmenuTriggerMouseLeave={onPlaylistSubmenuTriggerMouseLeave}
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
          pinToPlaybackServer={pinToPlaybackServer}
          navigateLibrary={navigateLibrary}
          offlinePolicy={offlinePolicy}
        />
      </div>
    </>
  );
}
