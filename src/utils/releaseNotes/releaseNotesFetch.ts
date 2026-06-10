export const RELEASE_NOTES_REPO = 'Psychotoxical/psysonic';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 64 * 1024;

/** Asset name for remote what's new (i18n: add locale suffix later). */
export function whatsNewAssetName(_locale?: string): string {
  return 'whats-new.md';
}

export function whatsNewDownloadUrl(version: string): string {
  const asset = whatsNewAssetName();
  return `https://github.com/${RELEASE_NOTES_REPO}/releases/download/app-v${version}/${asset}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchWhatsNewAsset(version: string): Promise<string | null> {
  const url = whatsNewDownloadUrl(version);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BODY_BYTES) continue;
      const text = new TextDecoder().decode(buf).trim();
      return text || null;
    } catch {
      // retry once on network/timeout
    }
  }
  return null;
}
