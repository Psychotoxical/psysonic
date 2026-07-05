import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { applyStartupSplashThemeFromStorage } from '@/lib/themes/startupThemeAppearance';
import { getWindowKind } from './windowKind';

export const STARTUP_SPLASH_ID = 'app-startup-splash';

/** Ensure the native shell is visible once the webview bundle is alive. */
export function revealStartupWindow(): void {
  if (getWindowKind() === 'mini') return;
  void getCurrentWebviewWindow().show().catch(() => {});
}

/** Re-apply splash colors after bootstrap theme migration/injection. */
export function configureStartupSplash(): void {
  const splash = document.getElementById(STARTUP_SPLASH_ID);
  if (!splash) return;

  if (getWindowKind() === 'mini') {
    splash.remove();
    return;
  }

  applyStartupSplashThemeFromStorage();
  revealStartupWindow();
}

/** Fade out the splash after the first React commit. */
export function dismissStartupSplash(): void {
  const splash = document.getElementById(STARTUP_SPLASH_ID);
  if (!splash || splash.classList.contains('app-startup-splash--hide')) return;

  splash.classList.add('app-startup-splash--hide');
  const remove = () => splash.remove();
  splash.addEventListener('transitionend', remove, { once: true });
  window.setTimeout(remove, 500);
}

/** Schedule dismiss on the frame after the first paint. */
export function scheduleStartupSplashDismiss(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(dismissStartupSplash);
  });
}
