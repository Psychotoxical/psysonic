import type { OfflineAlbumMeta } from '../../store/offlineStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { favoritesOfflineBrowseEnabled } from './favoritesOfflineBrowse';
import { hasOfflineBrowseCapability } from './offlineBrowseRouting';
import { offlineLocalBrowseEnabled } from './offlineLocalBrowse';
import { playlistsOfflineBrowseEnabled } from './offlinePlaylistBrowse';
import { hasAnyOfflineAlbums } from './offlineLibraryHelpers';

export type OfflineBrowseCapabilities = {
  localLibrary: boolean;
  favorites: boolean;
  playlists: boolean;
  manualPins: boolean;
  playerStats: boolean;
};

import type { ConnectionStatus } from '../../hooks/useConnectionStatus';

export type { ConnectionStatus };

export type OfflineBrowseContext = {
  active: boolean;
  serverId: string | null;
  capabilities: OfflineBrowseCapabilities;
  /** Disconnect fork / banner: local library, favorites, or manual pins. */
  hasBrowseCapability: boolean;
  /** Any offline bytes to show (includes favorite-auto without browse). */
  hasBrowsingContent: boolean;
  connStatus: ConnectionStatus;
};

export type ComputeOfflineBrowseCapabilitiesInput = {
  activeServerId: string | null;
  favoritesOfflineEnabled: boolean;
  offlineAlbums: Record<string, OfflineAlbumMeta>;
  playerStats: boolean;
};

/** Pure capability snapshot for tests and non-React callers. */
export function computeOfflineBrowseCapabilities(
  input: ComputeOfflineBrowseCapabilitiesInput,
): OfflineBrowseCapabilities {
  const { activeServerId, favoritesOfflineEnabled, offlineAlbums, playerStats } = input;
  const indexStore = useLibraryIndexStore.getState();
  const activeIndexEnabled = activeServerId ? indexStore.isIndexEnabled(activeServerId) : false;

  return {
    localLibrary: offlineLocalBrowseEnabled(activeServerId),
    favorites: favoritesOfflineEnabled && activeIndexEnabled,
    playlists: playlistsOfflineBrowseEnabled(activeServerId),
    manualPins: hasAnyOfflineAlbums(offlineAlbums),
    playerStats,
  };
}

export function buildOfflineBrowseContext(input: {
  active: boolean;
  serverId: string | null;
  capabilities: OfflineBrowseCapabilities;
  connStatus: ConnectionStatus;
  hasBrowsingContent: boolean;
}): OfflineBrowseContext {
  const { capabilities, hasBrowsingContent, ...rest } = input;
  return {
    ...rest,
    capabilities,
    hasBrowseCapability: hasOfflineBrowseCapability(
      capabilities.localLibrary,
      capabilities.favorites,
      capabilities.manualPins,
    ),
    hasBrowsingContent,
  };
}

/** Sidebar / disconnect helpers — matches legacy `favoritesOfflineBrowse` flag on active server. */
export function offlineBrowseNavFlags(capabilities: OfflineBrowseCapabilities): {
  favoritesOfflineBrowse: boolean;
  localLibraryBrowse: boolean;
  playlistsOfflineBrowse: boolean;
  playerStatsBrowse: boolean;
  hasManualOfflineContent: boolean;
} {
  return {
    favoritesOfflineBrowse: capabilities.favorites,
    localLibraryBrowse: capabilities.localLibrary,
    playlistsOfflineBrowse: capabilities.playlists,
    playerStatsBrowse: capabilities.playerStats,
    hasManualOfflineContent: capabilities.manualPins,
  };
}

/** Cross-server favorites scope (setting + any indexed server). */
export function favoritesBrowseCapabilityAnyServer(favoritesOfflineEnabled: boolean): boolean {
  if (!favoritesOfflineEnabled) return false;
  return favoritesOfflineBrowseEnabled();
}
