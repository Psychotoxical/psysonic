import { useEffect } from 'react';

/**
 * Surface "is the app currently being looked at?" as two `<html>` data
 * attributes so global CSS can pause cosmetic animations:
 *
 *  - `data-app-hidden` mirrors `document.hidden` (browser/tab hidden).
 *    Tauri `win.hide()` is mirrored separately by Rust via
 *    `data-psy-native-hidden`, since WebView2 may keep compositing.
 *  - `data-app-blurred` mirrors `document.hasFocus()` (window loses OS
 *    focus but stays visible — alt-tab, click into another app). On
 *    low-VRAM laptops WebView2 keeps compositing mesh blobs / waveform
 *    / marquee at full rate while unfocused — see issue #334.
 *
 * `window.__psyBlurred` is set as a JS-readable mirror for hot-path code
 * that can't go through the DOM (e.g. RAF loops).
 */
export function useAppActivityTracking(): void {
  useEffect(() => {
    const update = () => {
      document.documentElement.dataset.appHidden = document.hidden ? 'true' : 'false';
    };
    document.addEventListener('visibilitychange', update);
    update();
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    const update = () => {
      const blurred = !document.hasFocus();
      window.__psyBlurred = blurred;
      document.documentElement.dataset.appBlurred = blurred ? 'true' : 'false';
    };
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    update();
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);
}
