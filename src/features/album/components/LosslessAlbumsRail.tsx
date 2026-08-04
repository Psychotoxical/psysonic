import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import React, { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ndListLosslessAlbumsPageForServer } from '@/lib/api/navidromeBrowse';
import AlbumRow from '@/features/album/components/AlbumRow';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { runLocalLosslessAlbums } from '@/lib/library/browseTextSearch';
import { LOSSLESS_MODE_QUERY } from '@/lib/library/losslessMode';
import { runLibraryLocalReadSingleFlight } from '@/lib/library/localReadSingleFlight';
import { useLibraryScopeSyncRevision } from '@/store/offlineLocalLibrarySyncRevision';
import {
  readLosslessRailCache,
  writeLosslessRailCache,
} from '@/features/album/components/losslessAlbumsRailCache';
import {
  browseScopeLibraryIdsForServer,
  type LibraryBrowseScopePair,
} from '@/lib/library/libraryBrowseScope';

interface Props {
  /** Ordered Home scope. Omit to preserve the legacy active-server rail. */
  serverIds?: readonly string[];
  /** Bump when per-server library selections change without changing serverIds. */
  scopeVersion?: number;
  /** Explicit Home browse scope. Omit to preserve the legacy active-server rail. */
  scopes?: readonly LibraryBrowseScopePair[];
  disableArtwork?: boolean;
  artworkSize?: number;
  windowArtworkByViewport?: boolean;
  initialArtworkBudget?: number;
  onDiagnosticResult?: (result: LosslessAlbumsDiagnosticResult) => void;
}

export type LosslessAlbumsDiagnosticResult = {
  status: 'loading' | 'ready' | 'empty' | 'error' | 'timeout';
  durationMs?: number;
  itemCount?: number;
  detail?: string;
};

const TARGET_ALBUMS = 20;
const NETWORK_SONGS_PER_SERVER = 100;
const LOSSLESS_RAIL_DEADLINE_MS = 4000;
const LOSSLESS_LOCAL_READ_DEADLINE_MS = 1000;

async function withinDeadline<T>(request: Promise<T>, timeoutMs = LOSSLESS_RAIL_DEADLINE_MS): Promise<
  { status: 'ready'; value: T } | { status: 'timeout' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then(value => ({ status: 'ready' as const, value })),
      new Promise<{ status: 'timeout' }>(resolve => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function allocateQuotas(serverCount: number): number[] {
  if (serverCount <= 0) return [];
  const base = Math.floor(TARGET_ALBUMS / serverCount);
  const remainder = TARGET_ALBUMS % serverCount;
  return Array.from({ length: serverCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function roundRobinAlbums(groups: SubsonicAlbum[][]): SubsonicAlbum[] {
  const result: SubsonicAlbum[] = [];
  const maxLength = Math.max(0, ...groups.map(group => group.length));
  for (let index = 0; index < maxLength; index++) {
    for (const group of groups) {
      const album = group[index];
      if (album) result.push(album);
    }
  }
  return result.slice(0, TARGET_ALBUMS);
}

export default function LosslessAlbumsRail({
  serverIds,
  scopeVersion = 0,
  scopes,
  disableArtwork = false,
  artworkSize,
  windowArtworkByViewport,
  initialArtworkBudget,
  onDiagnosticResult,
}: Props) {
  const { t } = useTranslation();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const indexEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const orderedServerIds = useMemo(() => {
    const requested = serverIds ?? (activeServerId ? [activeServerId] : []);
    return [...new Set(requested.filter(Boolean))];
  }, [activeServerId, serverIds]);
  const librarySyncRevision = useLibraryScopeSyncRevision(orderedServerIds);
  const cacheKey = useMemo(() => JSON.stringify([
    orderedServerIds,
    scopeVersion,
    librarySyncRevision,
    indexEnabled,
  ]), [indexEnabled, librarySyncRevision, orderedServerIds, scopeVersion]);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>(() => (
    readLosslessRailCache(cacheKey)?.albums ?? []
  ));
  const reportDiagnostic = useEffectEvent((result: LosslessAlbumsDiagnosticResult) => {
    onDiagnosticResult?.(result);
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const startedAt = performance.now();
      const cached = readLosslessRailCache(cacheKey);
      if (cached) {
        setAlbums(cached.albums);
        reportDiagnostic({
          status: cached.status,
          durationMs: 0,
          itemCount: cached.albums.length,
          detail: 'cache',
        });
        return;
      }
      reportDiagnostic({ status: 'loading' });
      if (orderedServerIds.length === 0) {
        setAlbums([]);
        reportDiagnostic({
          status: 'empty',
          durationMs: performance.now() - startedAt,
          itemCount: 0,
          detail: 'no-servers',
        });
        return;
      }

      const quotas = allocateQuotas(orderedServerIds.length);
      const groups = await Promise.all(orderedServerIds.map(async (serverId, index) => {
        const serverStartedAt = performance.now();
        const finish = (
          albums: SubsonicAlbum[],
          status: 'ready' | 'empty' | 'error' | 'timeout',
          source: 'local' | 'network',
          detail?: string,
        ) => ({
          albums,
          status,
          detail: [
            `${serverId}:${source}:${Math.round(performance.now() - serverStartedAt)}ms/${albums.length}`,
            detail,
          ].filter(Boolean).join(' '),
        });
        const quota = quotas[index];
        if (quota <= 0) return finish([], 'empty', 'local');
        const explicitLibraryIds = scopes
          ? browseScopeLibraryIdsForServer(scopes, serverId)
          : [];

        if (indexEnabled) {
          try {
            const localResult = await withinDeadline(runLibraryLocalReadSingleFlight(
              JSON.stringify([
                'lossless-rail',
                orderedServerIds,
                scopeVersion,
                librarySyncRevision,
                serverId,
                quota,
              ]),
              () => scopes
                ? runLocalLosslessAlbums(serverId, quota, 0, scopes)
                : runLocalLosslessAlbums(serverId, quota, 0),
            ), LOSSLESS_LOCAL_READ_DEADLINE_MS);
            if (localResult.status === 'timeout' && explicitLibraryIds.length > 0) {
              return finish([], 'timeout', 'local', 'selected scope');
            }
            const local = localResult.status === 'ready' ? localResult.value : null;
            if (local?.albums.length) {
              return finish(
                local.albums.slice(0, quota).map(album => ({ ...album, serverId })),
                'ready',
                'local',
                local.diagnostics
                  ? `ready=${local.diagnostics.readyCheckMs}ms query=${local.diagnostics.queryMs}ms`
                  : undefined,
              );
            }
            if (explicitLibraryIds.length > 0) {
              return finish([], 'empty', 'local', 'selected scope');
            }
          } catch {
            if (explicitLibraryIds.length > 0) {
              return finish([], 'error', 'local', 'selected scope');
            }
            // Fall through to the network path for whole-server scopes.
          }
        } else if (explicitLibraryIds.length > 0) {
          return finish([], 'error', 'local', 'selected scope requires local index');
        }

        try {
          const remainingMs = Math.max(
            0,
            LOSSLESS_RAIL_DEADLINE_MS - (performance.now() - serverStartedAt),
          );
          if (remainingMs <= 0) return finish([], 'timeout', 'network');
          const result = await withinDeadline(ndListLosslessAlbumsPageForServer(serverId, {
              targetNewAlbums: quota,
              songsPerPage: NETWORK_SONGS_PER_SERVER,
              maxPagesPerCall: 1,
            }), remainingMs);
          if (result.status === 'timeout') {
            return finish([], 'timeout', 'network');
          }
          const networkAlbums = result.value.entries.slice(0, quota).map(entry => entry.album);
          return finish(networkAlbums, networkAlbums.length > 0 ? 'ready' : 'empty', 'network');
        } catch {
          return finish([], 'error', 'network');
        }
      }));

      if (cancelled) return;
      const nextAlbums = roundRobinAlbums(groups.map(group => group.albums));
      setAlbums(nextAlbums);
      const statuses = groups.map(group => group.status);
      const status: LosslessAlbumsDiagnosticResult['status'] = nextAlbums.length > 0
        ? 'ready'
        : statuses.includes('timeout')
          ? 'timeout'
          : statuses.includes('error')
            ? 'error'
            : 'empty';
      if (status === 'ready' || status === 'empty') {
        writeLosslessRailCache(cacheKey, { albums: nextAlbums, status });
      }
      reportDiagnostic({
        status,
        durationMs: performance.now() - startedAt,
        itemCount: nextAlbums.length,
        detail: groups.map(group => group.detail).join(', '),
      });
    })();
    return () => { cancelled = true; };
  }, [cacheKey, indexEnabled, orderedServerIds, scopeVersion, librarySyncRevision, scopes]);

  if (albums.length === 0) return null;

  return (
    <AlbumRow
      title={t('home.losslessAlbums')}
      titleLink="/lossless-albums"
      albums={albums}
      disableArtwork={disableArtwork}
      artworkSize={artworkSize}
      windowArtworkByViewport={windowArtworkByViewport}
      initialArtworkBudget={initialArtworkBudget}
      albumLinkQuery={LOSSLESS_MODE_QUERY}
    />
  );
}
