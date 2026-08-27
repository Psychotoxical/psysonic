import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { resolveStorageServerIndexKey } from '@/lib/server/serverIndexKey';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { navidromeCanonicalCheckpointStatus } from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { createNavidromeCanonicalMigrationAwareJSONStorage } from '@/lib/util/safeStorage';
import { withPlaylistPathIds } from '@/features/deviceSync/utils/deviceSyncHelpers';

export interface DeviceSyncSource {
  type: 'album' | 'playlist' | 'artist';
  id: string;
  name: string;
  serverIndexKey: string;
  /** Stable folder discriminator assigned when playlist display names collide. */
  pathId?: string;
  /** Album artist — only set when type === 'album'. Shown as a subtitle in the device list. */
  artist?: string;
}

export type LegacyDeviceSyncSource = Omit<DeviceSyncSource, 'serverIndexKey'>;

export type DeviceSyncManifest = {
  version?: number;
  schema?: string;
  canonicalIdVersion?: number;
  ownerServerIndexKey?: string;
  sources?: unknown[];
};

export function deviceSyncSourceKey(source: Pick<DeviceSyncSource, 'serverIndexKey' | 'type' | 'id'>): string {
  return JSON.stringify([source.serverIndexKey, source.type, source.id]);
}

export function deviceSyncOwnerKey(sources: readonly DeviceSyncSource[]): string | null {
  const owner = sources[0]?.serverIndexKey?.trim();
  if (!owner || sources.some(source => source.serverIndexKey !== owner)) return null;
  return owner;
}

function isDeviceSyncSource(value: unknown): value is DeviceSyncSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<DeviceSyncSource>;
  return (
    (source.type === 'album' || source.type === 'playlist' || source.type === 'artist') &&
    typeof source.id === 'string' && source.id.length > 0 &&
    typeof source.name === 'string' &&
    typeof source.serverIndexKey === 'string' && source.serverIndexKey.length > 0 &&
    (source.pathId === undefined || (typeof source.pathId === 'string' && source.pathId.length > 0))
  );
}

function isLegacyDeviceSyncSource(value: unknown): value is LegacyDeviceSyncSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<DeviceSyncSource>;
  return (
    (source.type === 'album' || source.type === 'playlist' || source.type === 'artist') &&
    typeof source.id === 'string' && source.id.length > 0 &&
    typeof source.name === 'string' &&
    !source.serverIndexKey
  );
}

function isSupportedDeviceSyncManifest(manifest: DeviceSyncManifest): boolean {
  if (manifest.version !== undefined
    && (!Number.isInteger(manifest.version) || manifest.version < 1 || manifest.version > 3)) return false;
  if (manifest.schema !== undefined && manifest.schema !== 'fixed-v1') return false;
  if (manifest.version === 3 && manifest.schema !== 'fixed-v1') return false;
  if (manifest.canonicalIdVersion !== undefined && manifest.canonicalIdVersion !== 1) return false;
  return true;
}

export function deviceSyncSourcesFromManifest(
  manifest: DeviceSyncManifest | null,
): DeviceSyncSource[] {
  return deviceSyncManifestImport(manifest)?.sources ?? [];
}

export function deviceSyncManifestImport(
  manifest: DeviceSyncManifest | null,
): { ownerServerIndexKey: string; sources: DeviceSyncSource[] } | null {
  if (!manifest || !isSupportedDeviceSyncManifest(manifest) || !Array.isArray(manifest.sources)) return null;
  const manifestOwner = manifest.ownerServerIndexKey
    ? resolveStorageServerIndexKey(manifest.ownerServerIndexKey)
    : null;
  const sources: DeviceSyncSource[] = [];
  for (const source of manifest.sources) {
    if (isDeviceSyncSource(source)) {
      const serverIndexKey = resolveStorageServerIndexKey(source.serverIndexKey);
      if (!serverIndexKey) return null;
      sources.push({ ...source, serverIndexKey });
      continue;
    }
    if (isLegacyDeviceSyncSource(source) && manifestOwner) {
      sources.push({ ...source, serverIndexKey: manifestOwner });
      continue;
    }
    return null;
  }
  const owner = deviceSyncOwnerKey(sources);
  if ((!owner && sources.length > 0) || (owner && manifestOwner && manifestOwner !== owner)) return null;
  const ownerServerIndexKey = owner ?? manifestOwner;
  if (!ownerServerIndexKey) return null;
  const checkpointStatus = navidromeCanonicalCheckpointStatus(ownerServerIndexKey);
  if (checkpointStatus === 'invalid' || checkpointStatus === 'pending') return null;
  const normalized = new Map<string, DeviceSyncSource>();
  for (const source of sources) {
    const next = checkpointStatus === 'ready'
      ? { ...source, id: canonicalNavidromeId(source.id) }
      : source;
    normalized.set(deviceSyncSourceKey(next), next);
  }
  return { ownerServerIndexKey, sources: withPlaylistPathIds([...normalized.values()]) };
}

export function deviceSyncLegacySourcesFromManifest(
  manifest: DeviceSyncManifest | null,
): LegacyDeviceSyncSource[] {
  if (!manifest
    || !isSupportedDeviceSyncManifest(manifest)
    || manifest.ownerServerIndexKey
    || !Array.isArray(manifest.sources)) return [];
  const legacy = new Map<string, LegacyDeviceSyncSource>();
  for (const source of manifest.sources) {
    if (!isLegacyDeviceSyncSource(source)) return [];
    legacy.set(JSON.stringify([source.type, source.id]), source);
  }
  return [...legacy.values()];
}

export function migrateDeviceSyncPersistedState(persisted: unknown): Partial<DeviceSyncState> {
  const state = persisted as Partial<DeviceSyncState> | undefined;
  const persistedSources = Array.isArray(state?.sources) ? state.sources : [];
  const persistedLegacySources = Array.isArray(state?.legacySources) ? state.legacySources : [];
  const legacySources = [
    ...persistedLegacySources.filter(isLegacyDeviceSyncSource),
    ...persistedSources.filter(isLegacyDeviceSyncSource),
  ];
  return {
    ...state,
    sources: withPlaylistPathIds(persistedSources.filter(isDeviceSyncSource)),
    legacySources,
    legacyTargetDir: legacySources.length > 0
      ? (typeof state?.legacyTargetDir === 'string' ? state.legacyTargetDir : state?.targetDir ?? null)
      : null,
    checkedIds: [],
    pendingDeletion: [],
  };
}

export type DeviceSyncLegacyRecovery =
  | { result: 'recovered'; sources: DeviceSyncSource[] }
  | { result: 'pending' | 'owner-conflict' };

export function prepareDeviceSyncLegacyRecovery(args: {
  sources: readonly DeviceSyncSource[];
  legacySources: readonly LegacyDeviceSyncSource[];
  serverIndexKey: string;
}): DeviceSyncLegacyRecovery {
  const serverIndexKey = resolveStorageServerIndexKey(args.serverIndexKey);
  const checkpointStatus = serverIndexKey
    ? navidromeCanonicalCheckpointStatus(serverIndexKey)
    : 'invalid';
  if (!serverIndexKey || checkpointStatus === 'invalid' || checkpointStatus === 'pending') {
    return { result: 'pending' };
  }
  const currentOwner = deviceSyncOwnerKey(args.sources);
  if (currentOwner && currentOwner !== serverIndexKey) return { result: 'owner-conflict' };
  const recovered = args.legacySources.map(source => ({
    ...source,
    id: checkpointStatus === 'ready' ? canonicalNavidromeId(source.id) : source.id,
    serverIndexKey,
  }));
  const merged = new Map(args.sources.map(source => [deviceSyncSourceKey(source), source]));
  recovered.forEach(source => merged.set(deviceSyncSourceKey(source), source));
  return { result: 'recovered', sources: withPlaylistPathIds([...merged.values()]) };
}

interface DeviceSyncState {
  targetDir: string | null;
  sources: DeviceSyncSource[];        // persistent device content list
  legacySources: LegacyDeviceSyncSource[]; // ownerless v0 selections awaiting explicit recovery
  legacyTargetDir: string | null;     // device the quarantined ownerless sources came from
  checkedIds: string[];               // currently checked for bulk actions (not persisted)
  pendingDeletion: string[];          // source IDs marked for deletion (not persisted)
  deviceFilePaths: string[];          // actual file paths found on the device (not persisted)
  scanning: boolean;                   // true while scanning the device

  setTargetDir: (dir: string | null) => void;
  addSource: (source: DeviceSyncSource) => void;
  removeSource: (id: string) => void;
  clearSources: () => void;
  setLegacySources: (sources: LegacyDeviceSyncSource[], targetDir?: string | null) => void;
  quarantineLegacySources: (targetDir: string, sources: LegacyDeviceSyncSource[]) => void;
  recoverLegacySources: (serverIndexKey: string) => 'recovered' | 'pending' | 'owner-conflict';
  discardLegacySources: () => void;
  toggleChecked: (id: string) => void;
  setCheckedIds: (ids: string[]) => void;
  markForDeletion: (ids: string[]) => void;
  unmarkDeletion: (id: string) => void;
  clearPendingDeletion: () => void;
  removeSources: (ids: string[]) => void;
  setDeviceFilePaths: (paths: string[]) => void;
  setScanning: (v: boolean) => void;
}

export const useDeviceSyncStore = create<DeviceSyncState>()(
  persist(
    (set, get) => ({
      targetDir: null,
      sources: [],
      legacySources: [],
      legacyTargetDir: null,
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,

      setTargetDir: (dir) => set({ targetDir: dir }),

      addSource: (source) =>
        set((s) => {
          const owner = deviceSyncOwnerKey(s.sources);
          const key = deviceSyncSourceKey(source);
          if (!source.serverIndexKey || (owner && owner !== source.serverIndexKey)) return s;
          return {
            sources: s.sources.some((x) => deviceSyncSourceKey(x) === key)
              ? s.sources
              : withPlaylistPathIds([...s.sources, source]),
          };
        }),

      removeSource: (id) =>
        set((s) => ({
          sources: s.sources.filter((x) => deviceSyncSourceKey(x) !== id),
          checkedIds: s.checkedIds.filter((x) => x !== id),
          pendingDeletion: s.pendingDeletion.filter((x) => x !== id),
        })),

      clearSources: () => set({ sources: [], checkedIds: [], pendingDeletion: [] }),
      setLegacySources: (legacySources, legacyTargetDir = null) => set({ legacySources, legacyTargetDir }),
      quarantineLegacySources: (legacyTargetDir, legacySources) => set(state => {
        const merged = new Map<string, LegacyDeviceSyncSource>();
        const existing = state.legacyTargetDir === legacyTargetDir ? state.legacySources : [];
        for (const source of [...existing, ...legacySources]) {
          merged.set(JSON.stringify([source.type, source.id]), source);
        }
        return {
          sources: [],
          checkedIds: [],
          pendingDeletion: [],
          legacySources: [...merged.values()],
          legacyTargetDir,
        };
      }),
      recoverLegacySources: (candidateOwner) => {
        const state = get();
        const recovery = prepareDeviceSyncLegacyRecovery({
          sources: state.sources,
          legacySources: state.legacySources,
          serverIndexKey: candidateOwner,
        });
        if (recovery.result !== 'recovered') return recovery.result;
        set({ sources: recovery.sources, legacySources: [], legacyTargetDir: null });
        return recovery.result;
      },
      discardLegacySources: () => set({ legacySources: [], legacyTargetDir: null }),

      toggleChecked: (id) =>
        set((s) => ({
          checkedIds: s.checkedIds.includes(id)
            ? s.checkedIds.filter((x) => x !== id)
            : [...s.checkedIds, id],
        })),

      setCheckedIds: (ids) => set({ checkedIds: ids }),

      markForDeletion: (ids) =>
        set((s) => ({
          pendingDeletion: [...new Set([...s.pendingDeletion, ...ids])],
          checkedIds: s.checkedIds.filter((x) => !ids.includes(x)),
        })),

      unmarkDeletion: (id) =>
        set((s) => ({
          pendingDeletion: s.pendingDeletion.filter((x) => x !== id),
        })),

      clearPendingDeletion: () => set({ pendingDeletion: [] }),

      removeSources: (ids) =>
        set((s) => ({
          sources: s.sources.filter((x) => !ids.includes(deviceSyncSourceKey(x))),
          checkedIds: s.checkedIds.filter((x) => !ids.includes(x)),
          pendingDeletion: s.pendingDeletion.filter((x) => !ids.includes(x)),
        })),

      setDeviceFilePaths: (paths) => set({ deviceFilePaths: paths }),
      setScanning: (v) => set({ scanning: v }),
    }),
    {
      name: 'psysonic_device_sync',
      storage: createNavidromeCanonicalMigrationAwareJSONStorage(),
      version: 3,
      migrate: (persisted) => migrateDeviceSyncPersistedState(persisted) as DeviceSyncState,
      partialize: (s) => ({
        targetDir: s.targetDir,
        sources: s.sources,
        legacySources: s.legacySources,
        legacyTargetDir: s.legacyTargetDir,
      }),
    }
  )
);
