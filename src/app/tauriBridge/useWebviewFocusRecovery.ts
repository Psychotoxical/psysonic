import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_LINUX } from '@/lib/util/platform';

/** Restore keyboard focus when a Linux compositor reactivates only the GTK window. */
export function useWebviewFocusRecovery(): void {
  useEffect(() => {
    if (!IS_LINUX) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) getCurrentWebview().setFocus().catch(() => {});
    }).then(stop => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
