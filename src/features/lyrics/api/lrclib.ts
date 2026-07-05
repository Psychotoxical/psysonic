export interface LrclibLyrics {
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

export interface LrcLine {
  time: number; // seconds
  text: string;
}

export async function fetchLyrics(
  artist: string,
  title: string,
  album: string,
  duration: number,
): Promise<LrclibLyrics | null> {
  const params = new URLSearchParams({
    artist_name: artist,
    track_name: title,
    album_name: album,
    duration: Math.round(duration).toString(),
  });
  try {
    const res = await fetch(`https://lrclib.net/api/get?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      syncedLyrics: data.syncedLyrics ?? null,
      plainLyrics: data.plainLyrics ?? null,
    };
  } catch {
    return null;
  }
}

export function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const line of lrc.split('\n')) {
    // \d+(?:\.\d*)? — decimal part is optional so [mm:ss] (no fraction) also matches.
    // parseFloat handles all forms: "15", "15.", "15.3", "15.32" correctly.
    const match = line.match(/^\[(\d+):(\d+(?:\.\d*)?)\](.*)/);
    if (!match) continue;
    const mins = parseInt(match[1], 10);
    const secs = parseFloat(match[2]);
    const text = match[3].trim();
    lines.push({ time: mins * 60 + secs, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}
