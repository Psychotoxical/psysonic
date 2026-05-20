/**
 * Is the local library index usable for `serverId` right now?
 *
 * Spec §5.13.6 / P8: consumers (Advanced Search, browse, …) only read from
 * the local index when it's both enabled and fully synced (`ready`); any
 * partial / disabled / errored state falls back to the network so results
 * are never silently incomplete.
 */
import { libraryGetStatus } from '../../api/library';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';

export async function libraryIsReady(serverId: string | null | undefined): Promise<boolean> {
  if (!serverId) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return false;
  try {
    const status = await libraryGetStatus(serverId);
    return status.syncPhase === 'ready';
  } catch {
    return false;
  }
}
