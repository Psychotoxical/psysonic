import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface DeviceSyncSource {
  type: 'album' | 'playlist' | 'artist';
  id: string;
  name: string;
  /** Album artist — only set when type === 'album'. Shown as a subtitle in the device list. */
  artist?: string;
}

interface DeviceSyncState {
  targetDir: string | null;
  sources: DeviceSyncSource[];        // persistent device content list
  checkedIds: string[];               // currently checked for bulk actions (not persisted)
  pendingDeletion: string[];          // source IDs marked for deletion (not persisted)
  deviceFilePaths: string[];          // actual file paths found on the device (not persisted)
  scanning: boolean;                   // true while scanning the device

  setTargetDir: (dir: string | null) => void;
  addSource: (source: DeviceSyncSource) => void;
  removeSource: (id: string) => void;
  clearSources: () => void;
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
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,

      setTargetDir: (dir) => set({ targetDir: dir }),

      addSource: (source) =>
        set((s) => ({
          sources: s.sources.some((x) => x.id === source.id)
            ? s.sources
            : [...s.sources, source],
        })),

      removeSource: (id) =>
        set((s) => ({
          sources: s.sources.filter((x) => x.id !== id),
          checkedIds: s.checkedIds.filter((x) => x !== id),
          pendingDeletion: s.pendingDeletion.filter((x) => x !== id),
        })),

      clearSources: () => set({ sources: [], checkedIds: [], pendingDeletion: [] }),

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
          sources: s.sources.filter((x) => !ids.includes(x.id)),
          checkedIds: s.checkedIds.filter((x) => !ids.includes(x)),
          pendingDeletion: s.pendingDeletion.filter((x) => !ids.includes(x)),
        })),

      setDeviceFilePaths: (paths) => set({ deviceFilePaths: paths }),
      setScanning: (v) => set({ scanning: v }),
    }),
    {
      name: 'psysonic_device_sync',
      partialize: (s) => ({
        targetDir: s.targetDir,
        sources: s.sources,
      }),
    }
  )
);
