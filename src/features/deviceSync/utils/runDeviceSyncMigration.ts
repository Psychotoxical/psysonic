import type React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { computeSyncPaths } from '@/lib/api/syncfs';
import { deviceSyncOwnerKey, type DeviceSyncSource } from '@/features/deviceSync/store/deviceSyncStore';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { applyLegacyTemplate } from '@/features/deviceSync/utils/deviceSyncLegacyTemplate';
import { trackToSyncInfo } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { fetchTracksForSource } from '@/features/playback/utils/playback/fetchTracksForSource';
import { IS_WINDOWS } from '@/lib/util/platform';

export type MigrationPhase = 'closed' | 'loading' | 'preview' | 'executing' | 'done' | 'nothing';

export interface MigrationPair { old: string; new: string; }
export interface MigrationResult { ok: number; failed: number; errors: string[]; }

export interface RunMigrationPreviewDeps {
  targetDir: string | null;
  sources: DeviceSyncSource[];
  setMigrationPhase: React.Dispatch<React.SetStateAction<MigrationPhase>>;
  setMigrationResult: React.Dispatch<React.SetStateAction<MigrationResult | null>>;
  setMigrationOldTemplate: React.Dispatch<React.SetStateAction<string>>;
  setMigrationPairs: React.Dispatch<React.SetStateAction<MigrationPair[]>>;
  setMigrationCollisions: React.Dispatch<React.SetStateAction<MigrationPair[]>>;
  setMigrationUnchanged: React.Dispatch<React.SetStateAction<number>>;
}

export async function runDeviceSyncMigrationPreview(deps: RunMigrationPreviewDeps): Promise<void> {
  const {
    targetDir, sources, setMigrationPhase, setMigrationResult, setMigrationOldTemplate,
    setMigrationPairs, setMigrationCollisions, setMigrationUnchanged,
  } = deps;

  if (!targetDir || sources.length === 0) return;
  setMigrationPhase('loading');
  setMigrationResult(null);
  try {
    // Look up the old template from the v1 manifest on disk.
    const manifest = await invoke<{ version: number; filenameTemplate?: string } | null>(
      'read_device_manifest', { destDir: targetDir }
    );
    const oldTemplate = manifest?.filenameTemplate?.trim() || '';
    if (!oldTemplate) {
      // v2 manifest or missing — nothing to migrate from.
      setMigrationPhase('nothing');
      return;
    }
    setMigrationOldTemplate(oldTemplate);

    // Migration only renames tracks that came from album/artist sources —
    // under the old template all tracks lived in a flat album tree. Playlist
    // sources get their own `Playlists/{name}/…` folder under the new scheme,
    // so the files they need are a subset (or copies) of the album tracks and
    // are cleaner to just re-download on the next sync.
    const albumSourceTracks: SubsonicSong[] = [];
    const seenIds = new Set<string>();
    for (const source of sources.filter(s => s.type !== 'playlist')) {
      try {
        const tracks = await fetchTracksForSource(source);
        for (const tr of tracks) {
          if (seenIds.has(tr.id)) continue;
          seenIds.add(tr.id);
          albumSourceTracks.push(tr);
        }
      } catch { /* skip unreachable source */ }
    }

    // New paths via Rust (fixed album-tree schema).
    const newAbsPaths = await computeSyncPaths({
      tracks: albumSourceTracks.map(tr => trackToSyncInfo(tr, '')),
      destDir: targetDir,
    });
    // Separators are normalised before the prefix is stripped. `targetDir` can
    // carry forward slashes while Rust builds the path with backslashes, and the
    // old comparison then never matched — the absolute path fell through as if
    // it were relative. The native side used to absorb that (joining an absolute
    // path silently replaces the base) but now rejects it as escaping the root,
    // so a separator mismatch would fail the whole migration.
    const sepChar = IS_WINDOWS ? '\\' : '/';
    const normalizeSeparators = (p: string) => (IS_WINDOWS ? p.replace(/\//g, '\\') : p);
    const normalizedTarget = normalizeSeparators(targetDir).replace(/[\\/]+$/, '');
    const prefix = normalizedTarget + sepChar;
    const newRelPaths = newAbsPaths.map(p => {
      const normalized = normalizeSeparators(p);
      return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    });

    // Old paths via the legacy template (JS).
    const oldRelPaths = albumSourceTracks.map(tr => applyLegacyTemplate(oldTemplate, {
      artist: tr.artist ?? '',
      album: tr.album ?? '',
      title: tr.title ?? '',
      trackNumber: tr.track,
      discNumber: tr.discNumber,
      year: tr.year,
      suffix: tr.suffix ?? 'mp3',
    }));

    const pairs: MigrationPair[] = [];
    const collisions: MigrationPair[] = [];
    const newPathCounts = new Map<string, number>();
    let unchanged = 0;

    for (let i = 0; i < albumSourceTracks.length; i++) {
      const o = oldRelPaths[i];
      const n = newRelPaths[i];
      if (o === n) { unchanged += 1; continue; }
      newPathCounts.set(n, (newPathCounts.get(n) ?? 0) + 1);
      pairs.push({ old: o, new: n });
    }
    // Two separate old files mapping onto the same new path → collision.
    const colliding = new Set([...newPathCounts.entries()].filter(([, c]) => c > 1).map(([p]) => p));
    const cleanPairs = pairs.filter(p => !colliding.has(p.new));
    for (const p of pairs.filter(p => colliding.has(p.new))) collisions.push(p);

    setMigrationPairs(cleanPairs);
    setMigrationCollisions(collisions);
    setMigrationUnchanged(unchanged);
    setMigrationPhase(cleanPairs.length === 0 && collisions.length === 0 ? 'nothing' : 'preview');
  } catch (e) {
    setMigrationResult({ ok: 0, failed: 0, errors: [String(e)] });
    setMigrationPhase('done');
  }
}

export interface RunMigrationExecuteDeps {
  targetDir: string | null;
  sources: DeviceSyncSource[];
  migrationPairs: MigrationPair[];
  setMigrationPhase: React.Dispatch<React.SetStateAction<MigrationPhase>>;
  setMigrationResult: React.Dispatch<React.SetStateAction<MigrationResult | null>>;
  scanDevice: () => Promise<void>;
}

export async function runDeviceSyncMigrationExecute(deps: RunMigrationExecuteDeps): Promise<void> {
  const { targetDir, sources, migrationPairs, setMigrationPhase, setMigrationResult, scanDevice } = deps;
  if (!targetDir || migrationPairs.length === 0) { setMigrationPhase('closed'); return; }
  setMigrationPhase('executing');
  try {
    const results = await invoke<{ oldPath: string; newPath: string; ok: boolean; error: string | null }[]>(
      'rename_device_files',
      { targetDir, pairs: migrationPairs.map(p => [p.old, p.new]) }
    );
    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const errors = results.filter(r => !r.ok).map(r => `${r.oldPath}: ${r.error ?? 'unknown'}`);
    setMigrationResult({ ok, failed, errors });
    const ownerServerIndexKey = deviceSyncOwnerKey(sources);
    if (ownerServerIndexKey) {
      await invoke('write_device_manifest', { destDir: targetDir, ownerServerIndexKey, sources });
    }
    await scanDevice();
    setMigrationPhase('done');
  } catch (e) {
    setMigrationResult({ ok: 0, failed: migrationPairs.length, errors: [String(e)] });
    setMigrationPhase('done');
  }
}
