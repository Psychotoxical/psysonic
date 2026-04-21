import type { ServerProfile } from '../store/authStore';

/** Library share (track / album / artist / queue). Same naming family as `psysonic1-` server invites. */
export const PSYSONIC_SHARE_PREFIX = 'psysonic2-';

export type EntityShareKind = 'track' | 'album' | 'artist';

export type SharePayloadV1 =
  | { srv: string; k: EntityShareKind; id: string }
  | { srv: string; k: 'queue'; ids: string[] };

export function normalizeShareServerUrl(url: string): string {
  const t = url.trim();
  if (!t) return '';
  const withScheme = t.startsWith('http') ? t : `http://${t}`;
  return withScheme.replace(/\/$/, '');
}

function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToUtf8(s: string): string {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function isEntityKind(k: unknown): k is EntityShareKind {
  return k === 'track' || k === 'album' || k === 'artist';
}

export function encodeSharePayload(payload: SharePayloadV1): string {
  const srvNorm = normalizeShareServerUrl(payload.srv);
  const body =
    payload.k === 'queue'
      ? JSON.stringify({
          v: 1,
          srv: srvNorm,
          k: 'queue',
          ids: payload.ids.map(id => String(id).trim()).filter(Boolean),
        })
      : JSON.stringify({
          v: 1,
          srv: srvNorm,
          k: payload.k,
          id: String(payload.id).trim(),
        });
  return PSYSONIC_SHARE_PREFIX + utf8ToBase64Url(body);
}

export function decodeSharePayloadFromText(text: string): SharePayloadV1 | null {
  const idx = text.indexOf(PSYSONIC_SHARE_PREFIX);
  if (idx < 0) return null;
  const after = text.slice(idx + PSYSONIC_SHARE_PREFIX.length);
  const token = after.match(/^([A-Za-z0-9_-]+)/)?.[1];
  if (!token) return null;
  try {
    const raw = JSON.parse(base64UrlToUtf8(token)) as Record<string, unknown>;
    if (raw.v !== 1) return null;
    const srv = typeof raw.srv === 'string' ? normalizeShareServerUrl(raw.srv) : '';
    if (!srv) return null;
    const k = raw.k;
    if (k === 'queue') {
      const idsRaw = raw.ids;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) return null;
      const ids = idsRaw.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
      if (ids.length === 0) return null;
      return { srv, k: 'queue', ids };
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || !isEntityKind(k)) return null;
    return { srv, k, id };
  } catch {
    return null;
  }
}

export function findServerIdForShareUrl(servers: ServerProfile[], shareSrv: string): string | null {
  const norm = normalizeShareServerUrl(shareSrv);
  const hit = servers.find(s => normalizeShareServerUrl(s.url) === norm);
  return hit?.id ?? null;
}
