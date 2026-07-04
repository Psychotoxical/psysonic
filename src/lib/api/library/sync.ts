/**
 * Session + lifecycle commands (PR-5b) — bind/clear sync sessions, start/cancel
 * syncs, mutate tracks, write artifacts/facts, purge. Split out of the former
 * single `lib/api/library.ts`; re-exported via the `@/lib/api/library` barrel.
 */
import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { serverIndexKeyForId } from './internal';
import type {
  PlaybackHint,
  SyncMode,
  SyncJobDto,
  PurgeReportDto,
  ArtifactInputDto,
  FactInputDto,
} from './dto';

export async function librarySyncBindSession(args: {
  serverId: string;
  baseUrl: string;
  username: string;
  password: string;
  libraryScope?: string;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.librarySyncBindSession(
    indexKey,
    args.baseUrl,
    args.username,
    args.password,
    args.libraryScope ?? null,
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function librarySyncClearSession(serverId: string): Promise<void> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.librarySyncClearSession(indexKey);
  if (res.status === 'error') throw new Error(res.error);
}

export async function libraryGetPlaybackHint(): Promise<PlaybackHint> {
  const res = await commands.libraryGetPlaybackHint();
  if (res.status === 'error') throw new Error(res.error);
  return res.data as PlaybackHint;
}

export async function librarySetPlaybackHint(hint: PlaybackHint): Promise<void> {
  const res = await commands.librarySetPlaybackHint(hint);
  if (res.status === 'error') throw new Error(res.error);
}

export async function librarySyncStart(args: {
  serverId: string;
  mode: SyncMode;
  libraryScope?: string;
}): Promise<SyncJobDto> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.librarySyncStart(indexKey, args.mode, args.libraryScope ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return { ...res.data, serverId: args.serverId };
}

/** Forced full-budget tombstone delta — Settings → «Verify integrity». */
export async function librarySyncVerifyIntegrity(args: {
  serverId: string;
  libraryScope?: string;
}): Promise<SyncJobDto> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.librarySyncVerifyIntegrity(indexKey, args.libraryScope ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return { ...res.data, serverId: args.serverId };
}

export async function librarySyncCancel(jobId?: string): Promise<void> {
  const res = await commands.librarySyncCancel(jobId ?? null);
  if (res.status === 'error') throw new Error(res.error);
}

export function libraryPatchTrack(args: {
  serverId: string;
  trackId: string;
  patch: {
    starredAt?: number | null;
    userRating?: number | null;
    playCount?: number | null;
    playedAt?: number | null;
    /** E2: playback-derived `md5_16kb` content fingerprint. Normally written
     *  by the Rust analysis bridge; exposed here for contract completeness. */
    contentHash?: string | null;
  };
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<void>('library_patch_track', { ...args, serverId: indexKey });
}

/** Server favorites → `album.starred_at` (UPDATE only, no stub rows). */
export async function libraryReconcileAlbumStars(args: {
  serverId: string;
  starredAlbums: Array<{ id: string; starredAt: number }>;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.libraryReconcileAlbumStars(
    indexKey,
    args.starredAlbums.map(a => ({ id: a.id, starredAt: a.starredAt })),
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function libraryPutArtifact(args: {
  serverId: string;
  trackId: string;
  artifact: ArtifactInputDto;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.libraryPutArtifact(indexKey, args.trackId, args.artifact);
  if (res.status === 'error') throw new Error(res.error);
}

export async function libraryPutFact(args: {
  serverId: string;
  trackId: string;
  fact: FactInputDto;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.libraryPutFact(indexKey, args.trackId, args.fact);
  if (res.status === 'error') throw new Error(res.error);
}

export async function libraryPurgeServer(args: {
  serverId: string;
  includeAnalysis?: boolean;
  includeOffline?: boolean;
}): Promise<PurgeReportDto> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.libraryPurgeServer(
    indexKey,
    args.includeAnalysis ?? null,
    args.includeOffline ?? null,
  );
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryDeleteServerData(serverId: string): Promise<void> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.libraryDeleteServerData(indexKey);
  if (res.status === 'error') throw new Error(res.error);
}
