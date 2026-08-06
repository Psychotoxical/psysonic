import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { resolveStorageServerIndexKey } from '@/lib/server/serverIndexKey';
import { canonicalizeConfirmedNavidromeId } from '@/lib/server/navidromeCanonicalIds';

export interface DeviceSyncSource {
  type: 'album' | 'playlist' | 'artist';
  id: string;
  name: string;
  serverIndexKey: string;
  /** Album artist — only set when type === 'album'. Shown as a subtitle in the device list. */
  artist?: string;
}

export type LegacyDeviceSyncSource = Omit<DeviceSyncSource, 'serverIndexKey'>;

export type DeviceSyncManifest = {
  version?: number;
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
    typeof source.serverIndexKey === 'string' && source.serverIndexKey.length > 0
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

export function deviceSyncSourcesFromManifest(
  manifest: DeviceSyncManifest | null,
  fallbackOwnerServerIndexKey?: string | null,
): DeviceSyncSource[] {
  if (!manifest || !Array.isArray(manifest.sources)) return [];
  const fallbackOwner = fallbackOwnerServerIndexKey
    ? resolveStorageServerIndexKey(fallbackOwnerServerIndexKey)
    : null;
  const manifestOwner = manifest.ownerServerIndexKey
    ? resolveStorageServerIndexKey(manifest.ownerServerIndexKey)
    : null;
  const sources = manifest.sources.flatMap(source => {
    if (isDeviceSyncSource(source)) {
      const serverIndexKey = resolveStorageServerIndexKey(source.serverIndexKey);
      return serverIndexKey ? [{
        ...source,
        serverIndexKey,
        id: canonicalizeConfirmedNavidromeId(serverIndexKey, source.id),
      }] : [];
    }
    return isLegacyDeviceSyncSource(source) && fallbackOwner
      ? [{
        ...source,
        serverIndexKey: fallbackOwner,
        id: canonicalizeConfirmedNavidromeId(fallbackOwner, source.id),
      }]
      : [];
  });
  const owner = deviceSyncOwnerKey(sources);
  if (!owner || (manifestOwner ? manifestOwner !== owner : fallbackOwner !== owner)) return [];
  return sources;
}

export function migrateDeviceSyncPersistedState(persisted: unknown): Partial<DeviceSyncState> {
  const state = persisted as Partial<DeviceSyncState> | undefined;
  const persistedSources = Array.isArray(state?.sources) ? state.sources : [];
  const persistedLegacySources = Array.isArray(state?.legacySources) ? state.legacySources : [];
  return {
    ...state,
    sources: persistedSources.filter(isDeviceSyncSource),
    legacySources: [
      ...persistedLegacySources.filter(isLegacyDeviceSyncSource),
      ...persistedSources.filter(isLegacyDeviceSyncSource),
    ],
    checkedIds: [],
    pendingDeletion: [],
  };
}

interface DeviceSyncState {
  targetDir: string | null;
  sources: DeviceSyncSource[];        // persistent device content list
  legacySources: LegacyDeviceSyncSource[]; // ownerless v0 selections awaiting explicit recovery
  checkedIds: string[];               // currently checked for bulk actions (not persisted)
  pendingDeletion: string[];          // source IDs marked for deletion (not persisted)
  deviceFilePaths: string[];          // actual file paths found on the device (not persisted)
  scanning: boolean;                   // true while scanning the device

  setTargetDir: (dir: string | null) => void;
  addSource: (source: DeviceSyncSource) => void;
  removeSource: (id: string) => void;
  clearSources: () => void;
  setLegacySources: (sources: LegacyDeviceSyncSource[]) => void;
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
    (set) => ({
      targetDir: null,
      sources: [],
      legacySources: [],
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,

      setTargetDir: (dir) => set({ targetDir: dir }),

      addSource: (source) =>
        set((s) => {
          source = {
            ...source,
            id: canonicalizeConfirmedNavidromeId(source.serverIndexKey, source.id),
          };
          const owner = deviceSyncOwnerKey(s.sources);
          const key = deviceSyncSourceKey(source);
          if (!source.serverIndexKey || (owner && owner !== source.serverIndexKey)) return s;
          const recoveredOwner = owner ?? source.serverIndexKey;
          const recovered = s.legacySources.map(legacy => ({
            ...legacy,
            serverIndexKey: recoveredOwner,
            id: canonicalizeConfirmedNavidromeId(recoveredOwner, legacy.id),
          }));
          const nextSources = [...s.sources, ...recovered];
          return {
            sources: nextSources.some((x) => deviceSyncSourceKey(x) === key)
              ? nextSources
              : [...nextSources, source],
            legacySources: [],
          };
        }),

      removeSource: (id) =>
        set((s) => ({
          sources: s.sources.filter((x) => deviceSyncSourceKey(x) !== id),
          checkedIds: s.checkedIds.filter((x) => x !== id),
          pendingDeletion: s.pendingDeletion.filter((x) => x !== id),
        })),

      clearSources: () => set({ sources: [], legacySources: [], checkedIds: [], pendingDeletion: [] }),
      setLegacySources: (legacySources) => set({ legacySources }),

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
      version: 2,
      migrate: (persisted) => migrateDeviceSyncPersistedState(persisted) as DeviceSyncState,
      partialize: (s) => ({
        targetDir: s.targetDir,
        sources: s.sources,
        legacySources: s.legacySources,
      }),
    }
  )
);
