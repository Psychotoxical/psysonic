import type { ServerProfile } from '@/store/authStoreTypes';
import { normalizeServerBaseUrl, serverShareBaseUrl } from '@/lib/server/serverEndpoint';

/**
 * Prefix for server invite strings (Subsonic credentials). Same family as library
 * shares in `shareLink.ts` (`psysonic2-` + payload).
 */
export const SERVER_MAGIC_STRING_PREFIX = 'psysonic1-';

/** Fixed-length placeholder so a password field does not reveal the real password length after decode. */
export const DECODED_PASSWORD_VISUAL_MASK = '••••••••••';

export interface ServerMagicPayload {
  /**
   * **v1:** the host's primary URL (also the connect URL for single-address
   * profiles).
   * **v2:** the host's **share URL** — public by default when both
   * addresses are set, or the local address if `shareUsesLocalUrl` flips it.
   * The receiver takes whichever they got and treats it as the primary URL
   * of the new profile (their own index key).
   */
  url: string;
  /**
   * v2 only — the host's alternate address. Empty / absent when the host
   * has a single-address profile or chose to share a v1 invite.
   */
  alternateUrl?: string;
  /**
   * v2 only — the host's preference for which address goes into future
   * share links from the receiver's side. Mirrors the source profile's
   * checkbox so a guest's onward shares behave the same way.
   */
  shareUsesLocalUrl?: boolean;
  username: string;
  password: string;
  /** Optional display name for the saved server entry */
  name?: string;
}

function utf8ToBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUtf8(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode server URL + Subsonic credentials into a single pasteable string.
 *
 * Emits **v2** when the payload carries an `alternateUrl` or
 * `shareUsesLocalUrl=true` (the dual-address shape — spec §10). Falls back
 * to **v1** otherwise, byte-identical with the pre-dual-address format so
 * older receivers keep working.
 */
export function encodeServerMagicString(p: ServerMagicPayload): string {
  const alt = p.alternateUrl?.trim() ?? '';
  const useV2 = alt.length > 0 || p.shareUsesLocalUrl === true;
  const base = {
    url: p.url.trim(),
    u: p.username,
    w: p.password,
    ...(p.name?.trim() ? { n: p.name.trim() } : {}),
  };
  if (useV2) {
    const v2 = {
      v: 2 as const,
      ...base,
      ...(alt ? { alt } : {}),
      ...(p.shareUsesLocalUrl ? { shareLocal: true as const } : {}),
    };
    return SERVER_MAGIC_STRING_PREFIX + utf8ToBase64Url(JSON.stringify(v2));
  }
  const v1 = { v: 1 as const, ...base };
  return SERVER_MAGIC_STRING_PREFIX + utf8ToBase64Url(JSON.stringify(v1));
}

/**
 * Decode a magic string from {@link encodeServerMagicString}.
 * Accepts optional surrounding whitespace.
 */
/**
 * Finds a server invite (`psysonic1-` + base64url payload) inside arbitrary pasted
 * text (e.g. a sentence with the token embedded).
 */
export function decodeServerMagicStringFromText(text: string): ServerMagicPayload | null {
  const idx = text.indexOf(SERVER_MAGIC_STRING_PREFIX);
  if (idx < 0) return null;
  const afterPrefix = text.slice(idx + SERVER_MAGIC_STRING_PREFIX.length);
  const token = afterPrefix.match(/^([A-Za-z0-9_-]+)/)?.[1];
  if (!token) return null;
  return decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX + token);
}

/**
 * Decode either a v1 or v2 invite. v2 surfaces `alternateUrl` + the share
 * preference; v1 leaves those fields undefined so single-address profiles
 * keep the same persisted shape.
 */
export function decodeServerMagicString(raw: string): ServerMagicPayload | null {
  const s = raw.trim();
  if (!s.startsWith(SERVER_MAGIC_STRING_PREFIX)) return null;
  const b64 = s.slice(SERVER_MAGIC_STRING_PREFIX.length).trim();
  if (!b64) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(base64UrlToUtf8(b64));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1 && o.v !== 2) return null;
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const username = typeof o.u === 'string' ? o.u : '';
  const password = typeof o.w === 'string' ? o.w : '';
  const name = typeof o.n === 'string' && o.n.trim() ? o.n.trim() : undefined;
  if (!url || !username) return null;

  if (o.v === 2) {
    const alt = typeof o.alt === 'string' ? o.alt.trim() : '';
    return {
      url,
      ...(alt ? { alternateUrl: alt } : {}),
      ...(o.shareLocal === true ? { shareUsesLocalUrl: true } : {}),
      username,
      password,
      name,
    };
  }
  return { url, username, password, name };
}

/**
 * Pick out the dual-address fields for the saved profile whose primary URL
 * or `alternateUrl` matches the given `serverUrl`. Returns the share URL +
 * the alternate + the share flag when those exist; falls back to just the
 * raw `serverUrl` for legacy / single-address profiles (v1 wire shape).
 *
 * Shared by `MagicStringModal` and `UserForm` (the two places we encode
 * server invites from). The lookup is normalize-aware so it tolerates
 * trailing-slash / scheme differences between the input URL and the saved
 * profile's URL.
 */
export function magicPayloadAddressFields(
  serverUrl: string,
  servers: ServerProfile[],
): {
  url: string;
  alternateUrl?: string;
  shareUsesLocalUrl?: boolean;
} {
  const normalized = normalizeServerBaseUrl(serverUrl);
  const match = servers.find(
    s =>
      normalizeServerBaseUrl(s.url) === normalized ||
      (s.alternateUrl != null && normalizeServerBaseUrl(s.alternateUrl) === normalized),
  );
  if (!match) return { url: serverUrl };
  return {
    url: serverShareBaseUrl(match),
    ...(match.alternateUrl ? { alternateUrl: match.alternateUrl } : {}),
    ...(match.shareUsesLocalUrl ? { shareUsesLocalUrl: true } : {}),
  };
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
