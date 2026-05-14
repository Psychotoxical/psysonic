import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useZipDownloadStore } from '../../store/zipDownloadStore';

/** ZIP download progress events from Rust. */
export function useZipDownloadBridge() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id: string; bytes: number; total: number | null }>('download:zip:progress', e => {
      useZipDownloadStore.getState().updateProgress(e.payload.id, e.payload.bytes, e.payload.total);
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);
}
