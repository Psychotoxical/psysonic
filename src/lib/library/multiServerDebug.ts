import { frontendDebugLog } from '@/lib/api/debugLog';
import {
  isDebugLoggingDepthEnabled,
  isDebugLoggingModeActive,
} from '@/lib/perf/debugLoggingMode';
import { serverProfileBaseUrl } from '@/lib/server/serverBaseUrl';

type DiagnosticServer = {
  id: string;
  name?: string;
  url?: string;
  alternateUrl?: string;
};

type DiagnosticFolder = {
  id: string;
  name?: string;
};

let sequence = 0;
const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

function diagnosticIndexKey(url: string): string {
  try {
    const parsed = new URL(serverProfileBaseUrl({ url }));
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.host}${path}`;
  } catch {
    return '[invalid-url]';
  }
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
      try {
        const parsed = new URL(raw);
        const path = parsed.pathname === '/' ? '' : parsed.pathname;
        return `${parsed.protocol}//${parsed.host}${path}`;
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/\b(password|token|api[_-]?key|authorization)=([^\s&]+)/gi, '$1=[redacted]');
}

export function describeMultiServerError(error: unknown): string {
  return redactDiagnosticText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

export function summarizeMultiServerProfiles(servers: readonly DiagnosticServer[]) {
  return servers.map((server, position) => ({
    position,
    profileId: server.id,
    name: server.name ?? '',
    indexKey: server.url ? diagnosticIndexKey(server.url) : '',
    hasPrimaryUrl: Boolean(server.url),
    hasAlternateUrl: Boolean(server.alternateUrl),
  }));
}

export function summarizeMusicFoldersByServer(
  foldersByServer: Record<string, readonly DiagnosticFolder[]>,
) {
  return Object.fromEntries(Object.entries(foldersByServer).map(([serverId, folders]) => [
    serverId,
    folders.map(folder => ({ id: folder.id, name: folder.name ?? '' })),
  ]));
}

/** High-detail multi-server diagnostics, available at debug depth 3. */
export function emitMultiServerDebug(
  step: string,
  details: Record<string, unknown> = {},
): void {
  if (!isDebugLoggingModeActive() || !isDebugLoggingDepthEnabled(3)) return;
  sequence += 1;
  frontendDebugLog('multi-server', JSON.stringify({
    step,
    sequence,
    elapsedMs: startedAt ? Math.round(performance.now() - startedAt) : 0,
    details,
  }), 3);
}
