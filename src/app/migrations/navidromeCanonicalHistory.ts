import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import {
  readRawAuthServerProfileGroups,
  type RawAuthServerProfileGroup,
} from './navidromeCanonicalAuth';
import { readNavidromeCanonicalMigrationCheckpoint } from './navidromeCanonicalCheckpoint';
import { classifyNavidromeCanonicalVersion } from './navidromeCanonicalVersion';
import type { NavidromeCanonicalFrontendScope } from './navidromeCanonicalFrontend';

const DETAIL_ROUTE = /^\/(album|artist|composer|playlists)\/([^/]+)$/;
const AUTH_KEY = 'psysonic-auth';

function activeProfileId(storage: Storage): string | null {
  const raw = storage.getItem(AUTH_KEY);
  if (!raw) return null;
  try {
    const root = JSON.parse(raw) as { state?: { activeServerId?: unknown } };
    return typeof root.state?.activeServerId === 'string' ? root.state.activeServerId : null;
  } catch {
    throw new Error(`Malformed persisted state in ${AUTH_KEY}`);
  }
}

function resolveOwnerServerIndexKey(
  value: string | null,
  scope: NavidromeCanonicalFrontendScope,
): string | null {
  if (!value) return null;
  return scope.profileServerIndexKeys[value]
    ?? (Object.values(scope.profileServerIndexKeys).includes(value) ? value : null);
}

function rewriteDetailUrl(
  value: string,
  scope: NavidromeCanonicalFrontendScope,
  fallbackOwner: string | null,
): string {
  if (!value.startsWith('/')) return value;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return value;
  }
  const match = DETAIL_ROUTE.exec(url.pathname);
  if (!match) return value;
  const owner = url.searchParams.get('server') ?? fallbackOwner;
  if (resolveOwnerServerIndexKey(owner, scope) !== scope.serverIndexKey) return value;

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(match[2]);
  } catch {
    return value;
  }
  const canonicalId = canonicalNavidromeId(decodedId);
  if (canonicalId === decodedId) return value;
  url.pathname = `/${match[1]}/${encodeURIComponent(canonicalId)}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

function rewriteHistoryState(
  value: unknown,
  scope: NavidromeCanonicalFrontendScope,
  fallbackOwner: string | null,
): { value: unknown; changed: boolean } {
  let changed = false;
  const seen = new WeakMap<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current !== 'object' || current === null) return current;
    const cached = seen.get(current);
    if (cached !== undefined) return cached;
    if (Array.isArray(current)) {
      const next: unknown[] = [];
      seen.set(current, next);
      current.forEach(item => next.push(visit(item)));
      return next;
    }
    const next: Record<string, unknown> = {};
    seen.set(current, next);
    for (const [key, nested] of Object.entries(current)) {
      if (key === 'returnTo' && typeof nested === 'string') {
        const rewritten = rewriteDetailUrl(nested, scope, fallbackOwner);
        if (rewritten !== nested) changed = true;
        next[key] = rewritten;
      } else {
        next[key] = visit(nested);
      }
    }
    return next;
  };
  return { value: visit(value), changed };
}

/** Rewrite the current route and React Router history state for one verified owner. */
export function rewriteNavidromeCanonicalHistoryForScope(
  scope: NavidromeCanonicalFrontendScope,
  storage: Storage = localStorage,
): boolean {
  const fallbackOwner = activeProfileId(storage);
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const rewrittenUrl = rewriteDetailUrl(currentUrl, scope, fallbackOwner);
  const rewrittenState = rewriteHistoryState(window.history.state, scope, fallbackOwner);
  if (rewrittenUrl === currentUrl && !rewrittenState.changed) return false;
  window.history.replaceState(rewrittenState.value, '', rewrittenUrl);
  return true;
}

function scopeForGroup(
  group: RawAuthServerProfileGroup,
  groups: readonly RawAuthServerProfileGroup[],
): NavidromeCanonicalFrontendScope {
  return {
    serverIndexKey: group.serverIndexKey,
    profileIds: group.profiles.map(profile => profile.id),
    profileServerIndexKeys: Object.fromEntries(groups.flatMap(candidate => (
      candidate.profiles.map(profile => [profile.id, candidate.serverIndexKey] as const)
    ))),
  };
}

/** Normalize bookmarks and POP navigation for every server with a verified canonical namespace. */
export function rewriteNavidromeCanonicalHistoryForReadyServers(
  storage: Storage = localStorage,
): boolean {
  const groups = readRawAuthServerProfileGroups(storage);
  const checkpoint = readNavidromeCanonicalMigrationCheckpoint(storage);
  let changed = false;
  for (const group of groups) {
    const saved = checkpoint?.servers[group.serverIndexKey];
    if (saved?.phase !== 'ready' || !saved.checkedVersion) continue;
    if (classifyNavidromeCanonicalVersion({
      type: 'navidrome',
      serverVersion: saved.checkedVersion,
    }) !== 'canonical') continue;
    changed = rewriteNavidromeCanonicalHistoryForScope(scopeForGroup(group, groups), storage) || changed;
  }
  return changed;
}

export function installNavidromeCanonicalHistoryNormalizer(
  storage: Storage = localStorage,
): () => void {
  const normalize = () => rewriteNavidromeCanonicalHistoryForReadyServers(storage);
  window.addEventListener('popstate', normalize);
  return () => window.removeEventListener('popstate', normalize);
}
