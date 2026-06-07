import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { useConnectionStatus } from './useConnectionStatus';
import { usePlayerStatsRecordingEnabled } from './usePlayerStatsRecordingEnabled';
import { hasOfflineBrowsingContent } from '../utils/offline/favoritesOfflineBrowse';
import { useOfflineBrowseActive } from '../utils/offline/offlineBrowseMode';
import {
  buildOfflineBrowseContext,
  computeOfflineBrowseCapabilities,
  type OfflineBrowseContext,
} from '../utils/offline/offlineBrowseContext';

/** Single subscription for shell and pages: offline browse mode + capabilities. */
export function useOfflineBrowseContext(): OfflineBrowseContext {
  const active = useOfflineBrowseActive();
  const serverId = useAuthStore(s => s.activeServerId);
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const offlineAlbums = useOfflineStore(s => s.albums);
  const playerStats = usePlayerStatsRecordingEnabled();
  const { status: connStatus } = useConnectionStatus();

  const capabilities = computeOfflineBrowseCapabilities({
    activeServerId: serverId,
    favoritesOfflineEnabled,
    offlineAlbums,
    playerStats,
  });

  return buildOfflineBrowseContext({
    active,
    serverId,
    capabilities,
    connStatus,
    hasBrowsingContent: hasOfflineBrowsingContent(offlineAlbums),
  });
}
