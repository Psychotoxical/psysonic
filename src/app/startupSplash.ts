import { applyStartupSplashThemeFromStorage } from '@/lib/themes/startupThemeAppearance';
import { getWindowKind } from './windowKind';

export const STARTUP_SPLASH_ID = 'app-startup-splash';
export const STARTUP_ROOT_PENDING_CLASS = 'app-root--startup-pending';

function revealStartupContent(): void {
  document.getElementById('root')?.classList.remove(STARTUP_ROOT_PENDING_CLASS);
}

/** Re-apply splash colors after bootstrap theme migration/injection. */
export function configureStartupSplash(): void {
  const splash = document.getElementById(STARTUP_SPLASH_ID);
  if (!splash) {
    revealStartupContent();
    return;
  }

  if (getWindowKind() === 'mini') {
    splash.remove();
    revealStartupContent();
    return;
  }

  applyStartupSplashThemeFromStorage();
}

/** Replace the splash with the fully prepared React tree in one paint. */
export function dismissStartupSplash(): void {
  const splash = document.getElementById(STARTUP_SPLASH_ID);
  splash?.remove();
  revealStartupContent();
}

/** Schedule the atomic handoff after the ready React state has committed. */
export function scheduleStartupSplashDismiss(): void {
  const root = document.getElementById('root');
  if (!document.getElementById(STARTUP_SPLASH_ID) && !root?.classList.contains(STARTUP_ROOT_PENDING_CLASS)) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(dismissStartupSplash);
  });
}
