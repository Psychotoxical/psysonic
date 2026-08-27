import {
  canonicalNavidromeArtworkId,
  canonicalNavidromeId,
} from '@/lib/server/navidromeCanonicalId';
import {
  navidromeCanonicalBootstrapBlocksServer,
  navidromeCanonicalCheckpointStatus,
} from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { serverIndexKeyFromUrl } from '@/lib/server/serverBaseUrl';

const SERVER_PROFILE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RawServerProfile = { id: string; url: string };

function resolveServerIndexKey(serverIdOrKey: string): string | null {
  const candidate = serverIdOrKey.trim();
  if (!candidate) return null;
  const raw = localStorage.getItem('psysonic-auth');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { state?: { servers?: unknown } };
      if (Array.isArray(parsed.state?.servers)) {
        const profile = parsed.state.servers.find((value): value is RawServerProfile => {
          if (typeof value !== 'object' || value === null) return false;
          const server = value as { id?: unknown; url?: unknown };
          return server.id === candidate && typeof server.url === 'string';
        });
        if (profile) return serverIndexKeyFromUrl(profile.url) || null;
      }
    } catch {
      return null;
    }
  }
  if (SERVER_PROFILE_UUID_RE.test(candidate)) return null;
  return serverIndexKeyFromUrl(candidate) || null;
}

export function activeServerIdForExternalIngress(): string | null {
  const raw = localStorage.getItem('psysonic-auth');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: { activeServerId?: unknown } };
    return typeof parsed.state?.activeServerId === 'string' ? parsed.state.activeServerId : null;
  } catch {
    return null;
  }
}

function readyStatus(serverIdOrKey: string): 'ready' | 'legacy' {
  const serverIndexKey = resolveServerIndexKey(serverIdOrKey);
  if (!serverIndexKey) return 'legacy';
  if (navidromeCanonicalBootstrapBlocksServer(serverIndexKey)) {
    throw new Error('canonical_migration_active');
  }
  const status = navidromeCanonicalCheckpointStatus(serverIndexKey);
  if (status === 'pending' || status === 'invalid') {
    throw new Error(`canonical_migration_not_ready:${serverIndexKey}`);
  }
  return status === 'ready' ? 'ready' : 'legacy';
}

/** Normalize an ID entering from a durable remote or user-controlled payload. */
export function normalizeNavidromeExternalId(serverIdOrKey: string, id: string): string {
  return readyStatus(serverIdOrKey) === 'ready' ? canonicalNavidromeId(id) : id;
}

/** Artwork IDs can carry Navidrome prefixes/suffixes around the entity ID. */
export function normalizeNavidromeExternalArtworkId(serverIdOrKey: string, id: string): string {
  return readyStatus(serverIdOrKey) === 'ready' ? canonicalNavidromeArtworkId(id) : id;
}
