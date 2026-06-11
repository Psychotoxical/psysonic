import { invoke, isTauri } from '@tauri-apps/api/core';

export const RELEASE_NOTES_REPO = 'Psychotoxical/psysonic';

const MAX_BODY_BYTES = 64 * 1024;

/** Asset name for remote what's new (i18n: add locale suffix later). */
export function whatsNewAssetName(_locale?: string): string {
  return 'whats-new.md';
}

export function whatsNewDownloadUrl(version: string): string {
  const asset = whatsNewAssetName();
  return `https://github.com/${RELEASE_NOTES_REPO}/releases/download/app-v${version}/${asset}`;
}

/**
 * GitHub release download URLs are served without CORS — use the Rust proxy
 * (same as radio favicons and other non-CORS endpoints).
 */
async function fetchBytesViaRust(url: string): Promise<Uint8Array> {
  const [bytes] = await invoke<[number[], string]>('fetch_url_bytes', { url });
  return new Uint8Array(bytes);
}

export async function fetchWhatsNewAsset(version: string): Promise<string | null> {
  if (!isTauri()) return null;

  const url = whatsNewDownloadUrl(version);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buf = await fetchBytesViaRust(url);
      if (buf.byteLength > MAX_BODY_BYTES) return null;
      const text = new TextDecoder().decode(buf).trim();
      return text || null;
    } catch {
      // Retry once on network/timeout only (404/4xx throw from Rust — same on retry).
      if (attempt === 1) return null;
    }
  }
  return null;
}
