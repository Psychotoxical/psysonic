import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '@/lib/util/platform';

export const SKIP_KEY = 'psysonic_skipped_update_version';

// Semver comparison: returns true if `a` is newer than `b`
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^[^0-9]*/, '').split('.').map(Number);
  const pb = b.replace(/^[^0-9]*/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

// Windows updates ship through WinGet, which moderates each new release for a
// while after the GitHub release goes live (installer scan + manual review,
// longer for freshly signed binaries building SmartScreen reputation). Holding
// the update notice back until the release clears this window avoids pointing
// Windows users at a version WinGet has not published yet. Conservative start
// value — tune down once real winget-pkgs merge times are known.
export const WINGET_MODERATION_DELAY_MS = 48 * 60 * 60 * 1000;

// True while `publishedAt` is younger than `windowMs` relative to `now`.
// Missing or unparseable date → false (fail open: show the notice rather than
// hide it indefinitely). Platform-agnostic so the time logic stays testable.
export function isWithinModerationWindow(
  publishedAt: string | undefined,
  now: number,
  windowMs: number = WINGET_MODERATION_DELAY_MS,
): boolean {
  if (!publishedAt) return false;
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  return now - published < windowMs;
}

export interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface ReleaseData {
  version: string;
  tag: string;
  body: string;
  assets: GithubAsset[];
}

export type DlState = 'idle' | 'downloading' | 'done' | 'error';

export function pickAsset(assets: GithubAsset[]): GithubAsset | undefined {
  if (IS_WINDOWS) {
    return assets.find(a => a.name.endsWith('-setup.exe'))
      ?? assets.find(a => a.name.endsWith('.exe'));
  }
  if (IS_MACOS) {
    // Prefer Apple Silicon, fall back to Intel
    return assets.find(a => a.name.endsWith('.dmg') && a.name.includes('aarch64'))
      ?? assets.find(a => a.name.endsWith('.dmg'));
  }
  if (IS_LINUX) {
    // AppImage > deb > rpm
    return assets.find(a => a.name.endsWith('.AppImage'))
      ?? assets.find(a => a.name.endsWith('.deb'))
      ?? assets.find(a => a.name.endsWith('.rpm'));
  }
  return undefined;
}
