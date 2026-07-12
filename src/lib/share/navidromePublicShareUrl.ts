/** Navidrome public share page: `{origin}{basePath}/share/{shareId}` (no auth). */
export type NavidromePublicShareRef = {
  pageUrl: string;
  origin: string;
  basePath: string;
  shareId: string;
};

const SHARE_ID_RE = /^[0-9A-Za-z]{10}$/;

function normalizeOrigin(url: URL): string {
  return url.origin;
}

function buildRef(url: URL, basePath: string, shareId: string): NavidromePublicShareRef {
  const origin = normalizeOrigin(url);
  const pageUrl = `${origin}${basePath}/share/${shareId}`;
  return { pageUrl, origin, basePath, shareId };
}

/** Parse a single URL string (must be the share page, not stream/img/m3u). */
export function parseNavidromePublicShareUrl(text: string): NavidromePublicShareRef | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const shareIdx = parts.lastIndexOf('share');
  if (shareIdx < 0 || shareIdx !== parts.length - 2) return null;

  const shareId = parts[shareIdx + 1] ?? '';
  if (!SHARE_ID_RE.test(shareId)) return null;

  const baseParts = parts.slice(0, shareIdx);
  const basePath = baseParts.length ? `/${baseParts.join('/')}` : '';
  return buildRef(url, basePath, shareId);
}

/** Find a Navidrome public share URL inside pasted or search text. */
export function extractNavidromePublicShareFromText(text: string): NavidromePublicShareRef | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = parseNavidromePublicShareUrl(trimmed);
  if (direct) return direct;

  const urlRe = /https?:\/\/[^\s<>"']+/gi;
  for (const match of trimmed.matchAll(urlRe)) {
    const candidate = match[0]!.replace(/[),.;!?]+$/g, '');
    const parsed = parseNavidromePublicShareUrl(candidate);
    if (parsed) return parsed;
  }

  return null;
}

export function buildNavidromePublicStreamUrl(
  ref: NavidromePublicShareRef,
  streamToken: string,
): string {
  const prefix = ref.basePath ? `${ref.origin}${ref.basePath}` : ref.origin;
  return `${prefix}/share/s/${streamToken}`;
}

/** Public artwork — reuses the track stream JWT (`/share/img/{token}`). */
export function buildNavidromePublicCoverUrl(
  ref: NavidromePublicShareRef,
  streamToken: string,
  size = 300,
): string {
  const prefix = ref.basePath ? `${ref.origin}${ref.basePath}` : ref.origin;
  return `${prefix}/share/img/${streamToken}?size=${size}`;
}

export function buildNavidromePublicShareM3uUrl(ref: NavidromePublicShareRef): string {
  return `${ref.pageUrl}/m3u`;
}
