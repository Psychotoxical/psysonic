import { commands } from '@/generated/bindings';

/** Fetches a synced LRC string from Netease Cloud Music via Rust proxy. Returns null if not found. */
export async function fetchNeteaselyrics(artist: string, title: string): Promise<string | null> {
  try {
    const res = await commands.fetchNeteaseLyrics(artist, title);
    if (res.status === 'error') throw new Error(res.error);
    return res.data;
  } catch {
    return null;
  }
}
