import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { usePreviewStore } from '../../store/previewStore';

/** Track-preview lifecycle: Rust audio engine emits start/progress/end. The
 * store mirrors them so any tracklist row can render its preview UI. */
export function usePreviewBridge() {
  useEffect(() => {
    const unlistenFns: Array<() => void> = [];
    listen<string>('audio:preview-start', e => {
      usePreviewStore.getState()._onStart(e.payload);
    }).then(u => unlistenFns.push(u));
    listen<{ id: string; elapsed: number; duration: number }>('audio:preview-progress', e => {
      usePreviewStore.getState()._onProgress(e.payload.id, e.payload.elapsed, e.payload.duration);
    }).then(u => unlistenFns.push(u));
    listen<{ id: string; reason: string }>('audio:preview-end', e => {
      usePreviewStore.getState()._onEnd(e.payload.id);
    }).then(u => unlistenFns.push(u));
    return () => { unlistenFns.forEach(fn => fn()); };
  }, []);
}
