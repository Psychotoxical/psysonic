import { create } from 'zustand';

export interface ZipDownload {
  id: string;
  filename: string;
  bytes: number;
  /** null = Content-Length unbekannt (Navidrome on-the-fly ZIP) */
  total: number | null;
  done: boolean;
  error: boolean;
}

interface ZipDownloadState {
  downloads: ZipDownload[];
  start: (id: string, filename: string) => void;
  updateProgress: (id: string, bytes: number, total: number | null) => void;
  complete: (id: string) => void;
  fail: (id: string) => void;
  dismiss: (id: string) => void;
}

export const useZipDownloadStore = create<ZipDownloadState>((set) => ({
  downloads: [],

  start: (id, filename) => set(state => ({
    downloads: [...state.downloads, { id, filename, bytes: 0, total: null, done: false, error: false }],
  })),

  updateProgress: (id, bytes, total) => set(state => ({
    downloads: state.downloads.map(d =>
      d.id === id ? { ...d, bytes, total: total ?? d.total } : d
    ),
  })),

  complete: (id) => set(state => ({
    downloads: state.downloads.map(d => d.id === id ? { ...d, done: true } : d),
  })),

  fail: (id) => set(state => ({
    downloads: state.downloads.map(d => d.id === id ? { ...d, error: true } : d),
  })),

  dismiss: (id) => set(state => ({
    downloads: state.downloads.filter(d => d.id !== id),
  })),
}));
