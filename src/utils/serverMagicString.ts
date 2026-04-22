/**
 * Prefix for server invite strings (Subsonic credentials). Same family as library
 * shares in `shareLink.ts` (`psysonic2-` + payload).
 */
export const SERVER_MAGIC_STRING_PREFIX = 'psysonic1-';

/** Fixed-length placeholder so a password field does not reveal the real password length after decode. */
export const DECODED_PASSWORD_VISUAL_MASK = '••••••••••';

export interface ServerMagicPayload {
  url: string;
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

/** Encode server URL + Subsonic credentials into a single pasteable string. */
export function encodeServerMagicString(p: ServerMagicPayload): string {
  const payload = {
    v: 1 as const,
    url: p.url.trim(),
    u: p.username,
    w: p.password,
    ...(p.name?.trim() ? { n: p.name.trim() } : {}),
  };
  return SERVER_MAGIC_STRING_PREFIX + utf8ToBase64Url(JSON.stringify(payload));
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
  if (o.v !== 1) return null;
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const username = typeof o.u === 'string' ? o.u : '';
  const password = typeof o.w === 'string' ? o.w : '';
  const name = typeof o.n === 'string' && o.n.trim() ? o.n.trim() : undefined;
  if (!url || !username) return null;
  return { url, username, password, name };
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
