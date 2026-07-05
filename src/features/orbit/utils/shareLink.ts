import { decodeOrbitSharePayloadFromText, encodeSharePayload } from '@/lib/share/shareLink';

export interface OrbitShareLink {
  /** Base URL of the Navidrome server (decoded). */
  serverBase: string;
  /** Session id (8 hex chars). */
  sid: string;
}

/**
 * Parse an orbit invite from pasted text. Accepts the magic-string format
 * `psysonic2-<base64url-json>` (same prefix family as library shares and
 * server invites). The caller decides what to do on null (show toast, etc.).
 */
export function parseOrbitShareLink(text: string): OrbitShareLink | null {
  if (!text) return null;
  const payload = decodeOrbitSharePayloadFromText(text);
  if (!payload) return null;
  let url: URL;
  try { url = new URL(payload.srv); } catch { return null; }
  // Only http(s) — a pasted invite must not smuggle file:/javascript:/etc.
  // Neutralized downstream by the known-server match too, but reject early.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return { serverBase: payload.srv, sid: payload.sid };
}

/** Build an orbit invite magic string for a live session. */
export function buildOrbitShareLink(serverBase: string, sid: string): string {
  return encodeSharePayload({ srv: serverBase, k: 'orbit', sid });
}
