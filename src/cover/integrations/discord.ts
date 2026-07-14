import { getAlbumInfo2 } from '@/lib/api/subsonicAlbumInfo';
import { isLanUrl } from '@/lib/server/serverEndpoint';

/**
 * Query-param keys that carry a replayable Subsonic (or generic API) secret.
 * Any URL carrying one of these must never be published to Discord — its
 * external image proxy exposes the full source URL to anyone viewing the
 * presence. Checked case-insensitively; Subsonic's own keys (`u`/`t`/`s`) are
 * lower-case but the defensive variants guard against other backends.
 */
const CREDENTIAL_PARAM_KEYS = new Set(['u', 't', 's', 'p', 'apikey', 'jwt', 'token', 'auth']);

/**
 * Gate every URL before it may become a Discord `large_image`. Discord's
 * external image proxy re-publishes the source URL to anyone who can view
 * the presence, so this rejects anything that isn't safe to publish:
 * https only, no embedded userinfo, no auth-shaped query params, no
 * LAN/loopback host (dead weight for Discord, reveals network topology).
 */
export function sanitizeDiscordCoverUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_PARAM_KEYS.has(key.toLowerCase())) return null;
  }
  if (isLanUrl(url.origin)) return null;
  return url.toString();
}

/**
 * Swap `raw`'s origin for `shareBase`'s, keeping query untouched and
 * preserving both URLs' paths. Navidrome's `getAlbumInfo2` derives the image
 * host from the request that reached it — when the app is connected over the
 * LAN address, the returned URL is LAN-scoped even though the server also
 * has a public address configured. The `/share/img/<jwt>` path itself is
 * host-independent, so pointing it at the profile's public share address
 * makes it reachable for Discord — but `shareBase` may itself carry a path
 * prefix (a server reachable behind a reverse proxy at e.g.
 * `https://host/nav`), which must be kept, not dropped, or the rewritten URL
 * 404s against the actual public endpoint.
 */
function rewriteOriginToShareBase(raw: string, shareBase: string): string {
  try {
    const url = new URL(raw);
    const share = new URL(shareBase);
    if (url.origin === share.origin) return raw;
    url.protocol = share.protocol;
    url.hostname = share.hostname;
    url.port = share.port;
    const sharePrefix = share.pathname.replace(/\/$/, '');
    if (sharePrefix && !url.pathname.startsWith(sharePrefix)) {
      url.pathname = `${sharePrefix}${url.pathname}`;
    }
    return url.toString();
  } catch {
    return raw;
  }
}

interface ServerCoverCacheEntry {
  url: string | null;
  fetchedAt: number;
}

/**
 * Session cache: `"<shareBase>|<albumId>"` -> resolved (already sanitized)
 * cover URL, or `null` for a miss/failure. Negative results are cached too —
 * at most one `getAlbumInfo2` call per album per server per TTL window.
 * TTL (not "forever") so a transient failure (server briefly unreachable,
 * timeout) doesn't hide an album's cover for the rest of the session —
 * mirrors the Rust-side iTunes artwork cache TTL for the same reason.
 */
const SERVER_COVER_CACHE_TTL_MS = 60 * 60 * 1000;
const serverCoverCache = new Map<string, ServerCoverCacheEntry>();

/**
 * Resolve a credential-free Discord cover URL for `albumId` via the
 * standard Subsonic `getAlbumInfo2` endpoint. Deliberately takes only an
 * album id and a share-base string — never a server profile/credentials —
 * so this resolver has no way to construct an authenticated URL, unlike the
 * removed `coverArtUrlForDiscord` that leaked `u`/`t`/`s` (see PR #1246).
 */
export async function resolveServerCoverForDiscord(
  albumId: string,
  shareBase: string | null,
): Promise<string | null> {
  const cacheKey = `${shareBase ?? ''}|${albumId}`;
  const cached = serverCoverCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SERVER_COVER_CACHE_TTL_MS) {
    return cached.url;
  }

  let result: string | null = null;
  const info = await getAlbumInfo2(albumId);
  const raw = info?.largeImageUrl || info?.mediumImageUrl || info?.smallImageUrl;
  if (raw) {
    const rewritten = shareBase ? rewriteOriginToShareBase(raw, shareBase) : raw;
    result = sanitizeDiscordCoverUrl(rewritten);
  }

  serverCoverCache.set(cacheKey, { url: result, fetchedAt: Date.now() });
  return result;
}
