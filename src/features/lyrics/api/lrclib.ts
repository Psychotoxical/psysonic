export interface LrclibLyrics {
  syncedLyrics: string | null;
  plainLyrics: string | null;
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
