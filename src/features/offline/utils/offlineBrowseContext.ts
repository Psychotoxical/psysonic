import type { ConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import type { OfflineAlbumMeta } from '@/features/offline/store/offlineStore';
import { favoritesOfflineBrowseEnabled } from '@/features/offline/utils/favoritesOfflineBrowse';
import { hasOfflineBrowseCapability } from '@/features/offline/utils/offlineBrowseRouting';
import { offlineLocalBrowseEnabled } from '@/features/offline/utils/offlineLocalBrowse';
import { playlistsOfflineBrowseEnabled } from '@/features/offline/utils/offlinePlaylistBrowse';
import { hasAnyOfflineAlbums } from '@/features/offline/utils/offlineLibraryHelpers';

export type OfflineBrowseCapabilities = {
  localLibrary: boolean;
  favorites: boolean;
  playlists: boolean;
  manualPins: boolean;
  playerStats: boolean;
};

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

type ComputeOfflineBrowseCapabilitiesInput = {
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

  return {
    localLibrary: offlineLocalBrowseEnabled(activeServerId),
    favorites: favoritesBrowseCapabilityAnyServer(favoritesOfflineEnabled),
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

/** Sidebar / disconnect helpers — maps capability snapshot to nav gate flags. */
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
function favoritesBrowseCapabilityAnyServer(favoritesOfflineEnabled: boolean): boolean {
  if (!favoritesOfflineEnabled) return false;
  return favoritesOfflineBrowseEnabled();
}
