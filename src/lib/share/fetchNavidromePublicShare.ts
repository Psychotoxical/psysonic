import type { NavidromePublicShareRef } from '@/lib/share/navidromePublicShareUrl';
import {
  buildNavidromePublicShareM3uUrl,
  buildNavidromePublicCoverUrl,
} from '@/lib/share/navidromePublicShareUrl';
import type {
  FetchNavidromePublicShareResult,
  NavidromePublicShareInfo,
  NavidromePublicShareTrack,
} from '@/lib/share/navidromePublicShareTypes';

export type FetchNavidromePublicShareFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

const defaultFetch: FetchNavidromePublicShareFn = (url, init) => fetch(url, init);

function parseShareInfoJson(raw: unknown): NavidromePublicShareInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!id) return null;

  const description = typeof obj.description === 'string' ? obj.description : '';
  const downloadable = obj.downloadable === true;
  const tracksRaw = obj.tracks;
  if (!Array.isArray(tracksRaw) || tracksRaw.length === 0) return null;

  const tracks: NavidromePublicShareTrack[] = [];
  for (const row of tracksRaw) {
    if (!row || typeof row !== 'object') continue;
    const t = row as Record<string, unknown>;
    const token = typeof t.id === 'string' ? t.id.trim() : '';
    const title = typeof t.title === 'string' ? t.title : '';
    if (!token || !title) continue;
    tracks.push({
      id: token,
      title,
      artist: typeof t.artist === 'string' ? t.artist : '',
      album: typeof t.album === 'string' ? t.album : '',
      duration: typeof t.duration === 'number' && Number.isFinite(t.duration) ? t.duration : 0,
    });
  }

  if (tracks.length === 0) return null;
  return { id, description, downloadable, tracks };
}

/** Navidrome assigns `window.__SHARE_INFO__ = "{...json...}"` (escaped JSON in JS quotes). */
function decodeJsStringLiteral(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return ch;
    }
  });
}

function parseShareInfoFromJsonText(jsonText: string): NavidromePublicShareInfo | null {
  try {
    return parseShareInfoJson(JSON.parse(jsonText));
  } catch {
    return null;
  }
}

export function parseShareInfoFromHtml(html: string): NavidromePublicShareInfo | null {
  const marker = 'window.__SHARE_INFO__';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;

  const afterMarker = html.slice(idx + marker.length);

  const stringAssign = afterMarker.match(/^\s*=\s*"((?:\\.|[^"\\])*)"/);
  if (stringAssign?.[1]) {
    const fromString = parseShareInfoFromJsonText(decodeJsStringLiteral(stringAssign[1]));
    if (fromString) return fromString;
  }

  const start = afterMarker.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < afterMarker.length; i++) {
    const ch = afterMarker[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonText = afterMarker.slice(start, i + 1);
        return parseShareInfoFromJsonText(jsonText);
      }
    }
  }
  return null;
}

export function parseShareInfoFromM3u(body: string): NavidromePublicShareTrack[] {
  const lines = body.split(/\r?\n/);
  const tracks: NavidromePublicShareTrack[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith('#EXTINF:')) continue;
    const meta = line.slice('#EXTINF:'.length);
    const comma = meta.lastIndexOf(',');
    const title = comma >= 0 ? meta.slice(comma + 1).trim() : meta.trim();
    const urlLine = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith('#'))?.trim();
    if (!urlLine || !title) continue;
    const token = urlLine.split('/').pop() ?? '';
    if (!token) continue;
    tracks.push({
      id: token,
      title,
      artist: '',
      album: '',
      duration: 0,
    });
    i += 1;
  }
  return tracks;
}

function mapHttpStatus(status: number): FetchNavidromePublicShareResult {
  if (status === 404) return { type: 'error', reason: 'not-found' };
  if (status === 410) return { type: 'error', reason: 'expired' };
  return { type: 'error', reason: 'malformed' };
}

function parseOgImage(html: string): string | undefined {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return m?.[1];
}

function sharePreviewImageUrl(
  ref: NavidromePublicShareRef,
  info: NavidromePublicShareInfo,
  ogImage?: string,
): string | undefined {
  const firstTrack = info.tracks[0];
  if (firstTrack) return buildNavidromePublicCoverUrl(ref, firstTrack.id);
  return ogImage;
}

export async function fetchNavidromePublicShare(
  ref: NavidromePublicShareRef,
  fetchImpl: FetchNavidromePublicShareFn = defaultFetch,
): Promise<FetchNavidromePublicShareResult> {
  let htmlResp: Response;
  try {
    htmlResp = await fetchImpl(ref.pageUrl, {
      method: 'GET',
      headers: { Accept: 'text/html,*/*' },
    });
  } catch {
    return { type: 'error', reason: 'unreachable' };
  }

  if (htmlResp.status === 404) return { type: 'error', reason: 'not-found' };
  if (htmlResp.status === 410) return { type: 'error', reason: 'expired' };
  if (!htmlResp.ok) return mapHttpStatus(htmlResp.status);

  const html = await htmlResp.text();
  const fromHtml = parseShareInfoFromHtml(html);
  if (fromHtml) {
    const ogImage = parseOgImage(html);
    return {
      type: 'ok',
      info: {
        ...fromHtml,
        imageUrl: sharePreviewImageUrl(ref, fromHtml, ogImage),
      },
    };
  }

  try {
    const m3uResp = await fetchImpl(buildNavidromePublicShareM3uUrl(ref), {
      method: 'GET',
      headers: { Accept: 'audio/x-mpegurl,*/*' },
    });
    if (m3uResp.status === 404) return { type: 'error', reason: 'not-found' };
    if (m3uResp.status === 410) return { type: 'error', reason: 'expired' };
    if (!m3uResp.ok) return mapHttpStatus(m3uResp.status);

    const tracks = parseShareInfoFromM3u(await m3uResp.text());
    if (tracks.length === 0) return { type: 'error', reason: 'malformed' };

    return {
      type: 'ok',
      info: {
        id: ref.shareId,
        description: '',
        downloadable: false,
        tracks,
        imageUrl: sharePreviewImageUrl(ref, { id: ref.shareId, description: '', downloadable: false, tracks }),
      },
    };
  } catch {
    return { type: 'error', reason: 'unreachable' };
  }
}
