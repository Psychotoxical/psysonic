import { useMemo } from 'react';
import {
  hasOfflineBrowseCapability,
  offlineLocalBrowseEnabled,
  useOfflineBrowseContext,
  type OfflineBrowseContext,
} from '@/features/offline';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';

/** Hot-cache rows update sidebar and shell offline gates without polling getState(). */
export function useReactiveOfflineBrowseContext(): OfflineBrowseContext {
  const ctx = useOfflineBrowseContext();
  const entries = useLocalPlaybackStore(s => s.entries);
  return useMemo(() => {
    const localLibrary = offlineLocalBrowseEnabled(ctx.serverId, entries);
    const capabilities = { ...ctx.capabilities, localLibrary };
    return {
      ...ctx,
      capabilities,
      hasBrowseCapability: hasOfflineBrowseCapability(
        capabilities.localLibrary,
        capabilities.favorites,
        capabilities.manualPins,
      ),
    };
  }, [ctx, entries]);
}
