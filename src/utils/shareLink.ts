import type { ServerProfile } from '../store/authStore';

/** Library share (track / album / artist / queue). Same naming family as `psysonic1-` server invites. */
export const PSYSONIC_SHARE_PREFIX = 'psysonic2-';

export type EntityShareKind = 'track' | 'album' | 'artist' | 'composer';

/** Entity / queue shares — what {@link applySharePastePayload} dispatches on. */
export type EntitySharePayloadV1 =
  | { srv: string; k: EntityShareKind; id: string }
  | { srv: string; k: 'queue'; ids: string[] };

/** Orbit invite — session id + originating server. Decoded separately so that
 *  entity-share consumers can't accidentally receive an orbit payload. */
export type OrbitSharePayloadV1 = { srv: string; k: 'orbit'; sid: string };

export type SharePayloadV1 = EntitySharePayloadV1 | OrbitSharePayloadV1;

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
  return k === 'track' || k === 'album' || k === 'artist' || k === 'composer';
}

export function encodeSharePayload(payload: SharePayloadV1): string {
  const srvNorm = normalizeShareServerUrl(payload.srv);
  let body: string;
  if (payload.k === 'queue') {
    body = JSON.stringify({
      v: 1,
      srv: srvNorm,
      k: 'queue',
      ids: payload.ids.map(id => String(id).trim()).filter(Boolean),
    });
  } else if (payload.k === 'orbit') {
    body = JSON.stringify({
      v: 1,
      srv: srvNorm,
      k: 'orbit',
      sid: String(payload.sid).trim(),
    });
  } else {
    body = JSON.stringify({
      v: 1,
      srv: srvNorm,
      k: payload.k,
      id: String(payload.id).trim(),
    });
  }
  return PSYSONIC_SHARE_PREFIX + utf8ToBase64Url(body);
}

/**
 * Decode an entity / queue share from pasted text. Returns null for orbit
 * payloads (use {@link decodeOrbitSharePayloadFromText}) — so entity-share
 * consumers can't be fed an orbit invite by accident.
 */
export function decodeSharePayloadFromText(text: string): EntitySharePayloadV1 | null {
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
    if (k === 'orbit') return null;
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

/** Decode an orbit invite from pasted text. Returns null for entity / queue shares. */
export function decodeOrbitSharePayloadFromText(text: string): OrbitSharePayloadV1 | null {
  const idx = text.indexOf(PSYSONIC_SHARE_PREFIX);
  if (idx < 0) return null;
  const after = text.slice(idx + PSYSONIC_SHARE_PREFIX.length);
  const token = after.match(/^([A-Za-z0-9_-]+)/)?.[1];
  if (!token) return null;
  try {
    const raw = JSON.parse(base64UrlToUtf8(token)) as Record<string, unknown>;
    if (raw.v !== 1) return null;
    if (raw.k !== 'orbit') return null;
    const srv = typeof raw.srv === 'string' ? normalizeShareServerUrl(raw.srv) : '';
    if (!srv) return null;
    const sid = typeof raw.sid === 'string' ? raw.sid.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{8}$/.test(sid)) return null;
    return { srv, k: 'orbit', sid };
  } catch {
    return null;
  }
}
