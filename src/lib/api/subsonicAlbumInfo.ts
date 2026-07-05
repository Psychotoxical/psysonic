import { api } from '@/lib/api/subsonicClient';
import type { AlbumInfo } from '@/lib/api/subsonicTypes';

export async function getAlbumInfo2(albumId: string): Promise<AlbumInfo | null> {
  try {
    const data = await api<{ albumInfo: AlbumInfo }>('getAlbumInfo2.view', { id: albumId });
    return data.albumInfo ?? null;
  } catch {
    return null;
  }
}
