import { create } from 'zustand';

import type { ArtistAlbumYearOrder } from '@/features/artist/utils/sortArtistAlbums';

export const DEFAULT_ARTIST_ALBUM_YEAR_ORDER: ArtistAlbumYearOrder = 'yearDesc';

interface ArtistAlbumYearSortStore {
  orderByServer: Record<string, ArtistAlbumYearOrder>;
  yearOrderFor: (serverId: string) => ArtistAlbumYearOrder;
  toggleYearOrder: (serverId: string) => void;
}

export const useArtistAlbumYearSortStore = create<ArtistAlbumYearSortStore>((set, get) => ({
  orderByServer: {},

  yearOrderFor: (serverId) =>
    get().orderByServer[serverId] ?? DEFAULT_ARTIST_ALBUM_YEAR_ORDER,

  toggleYearOrder: (serverId) => {
    if (!serverId) return;
    const current = get().yearOrderFor(serverId);
    const next: ArtistAlbumYearOrder = current === 'yearDesc' ? 'yearAsc' : 'yearDesc';
    set(s => ({
      orderByServer: { ...s.orderByServer, [serverId]: next },
    }));
  },
}));
