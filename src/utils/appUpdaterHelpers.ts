import { IS_LINUX, IS_MACOS, IS_WINDOWS } from './platform';

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

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
