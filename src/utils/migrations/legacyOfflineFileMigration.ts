import { invoke } from '@tauri-apps/api/core';
import { useLocalPlaybackStore, type LocalPlaybackEntry } from '../../store/localPlaybackStore';
import { localPlaybackEntryKey } from '../../store/localPlaybackKeys';
import { getMediaDir } from '../media/mediaDir';
import { resolveServerIdForIndexKey } from '../server/serverLookup';

interface LegacyOfflineMigrationResult {
  trackId: string;
  serverIndexKey: string;
  path: string;
  size: number;
  layoutFingerprint: string;
  relocated: boolean;
  skippedReason?: string | null;
}

/** True when the file still uses the flat legacy offline layout (not under `media/…/library/`). */
export function entryNeedsFileRelocation(entry: LocalPlaybackEntry): boolean {
  if (entry.tier !== 'library' || !entry.localPath.trim()) return false;
  const normalized = entry.localPath.replace(/\\/g, '/');
  if (normalized.includes('/media/library/')) return false;
  if (normalized.includes('/psysonic-offline/')) return true;
  // Custom offline root: `{userDir}/{serverSegment}/{trackId}.ext` — no `/library/` segment.
  return !normalized.includes('/library/');
}

function collectRelocationItems(
  serverIndexKey?: string,
): Array<{
  trackId: string;
  serverIndexKey: string;
  libraryServerId: string;
  oldPath: string;
  suffix: string;
}> {
  const entries = Object.values(useLocalPlaybackStore.getState().entries);
  return entries
    .filter(e => (!serverIndexKey || e.serverIndexKey === serverIndexKey) && entryNeedsFileRelocation(e))
    .map(e => ({
      trackId: e.trackId,
      serverIndexKey: e.serverIndexKey,
      libraryServerId: resolveServerIdForIndexKey(e.serverIndexKey) || e.serverIndexKey,
      oldPath: e.localPath,
      suffix: e.suffix || 'mp3',
    }));
}

function applyMigrationResults(results: LegacyOfflineMigrationResult[]): number {
  let relocated = 0;
  const store = useLocalPlaybackStore.getState();
  for (const r of results) {
    const key = localPlaybackEntryKey(r.serverIndexKey, r.trackId);
    const prev = store.entries[key];
    if (!prev) continue;
    if (!r.path || r.skippedReason === 'library_track_not_found') continue;
    store.upsertEntry({
      ...prev,
      localPath: r.path,
      sizeBytes: r.size || prev.sizeBytes,
      layoutFingerprint: r.layoutFingerprint || prev.layoutFingerprint,
    });
    if (r.relocated) relocated += 1;
  }
  return relocated;
}

/** Best-effort relocate legacy offline bytes into `media/library/…`. Returns count moved. */
export async function migrateLegacyOfflineFiles(serverIndexKey?: string): Promise<number> {
  const items = collectRelocationItems(serverIndexKey);
  if (items.length === 0) return 0;
  const results = await invoke<LegacyOfflineMigrationResult[]>('migrate_legacy_offline_files', {
    items,
    mediaDir: getMediaDir(),
  });
  return applyMigrationResults(results);
}
