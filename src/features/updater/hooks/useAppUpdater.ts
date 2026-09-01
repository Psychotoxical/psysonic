import { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { dirname } from '@tauri-apps/api/path';
import { commands } from '@/generated/bindings';
import { useTranslation } from 'react-i18next';
import { version as currentVersion } from '../../../../package.json';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '@/lib/util/platform';
import { SKIP_KEY, isNewer, isWithinModerationWindow, pickAsset, type ReleaseData, type DlState } from '@/lib/util/appUpdaterHelpers';

/** Platforms where the Tauri Updater plugin installs the update from inside
 * the app. Linux stays on the manual download: deb/rpm/AppImage/AUR/Nix have
 * no sensible in-place path. */
export type UpdaterPlatform = 'macos' | 'windows' | null;

/** All update-modal state, the GitHub release probe and the download/relaunch
 * handlers. The component owns only the early-return guard and the JSX. */
export function useAppUpdater() {
  const { t } = useTranslation();
  const [release, setRelease] = useState<ReleaseData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [isArch, setIsArch] = useState(false);
  const [dlState, setDlState] = useState<DlState>('idle');
  const [dlProgress, setDlProgress] = useState({ bytes: 0, total: 0 });
  const [dlPath, setDlPath] = useState('');
  const [dlError, setDlError] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const countdownRef = useRef<number | null>(null);
  const relaunchFnRef = useRef<(() => Promise<void>) | null>(null);
  const updaterPlatform: UpdaterPlatform = IS_MACOS ? 'macos' : IS_WINDOWS ? 'windows' : null;

  const fetchRelease = async (preview = false) => {
    try {
      const res = await fetch('https://api.github.com/repos/Psysonic/psysonic/releases/latest');
      if (!res.ok) return;
      const data = await res.json();
      const tag: string = data.tag_name ?? '';
      const version = tag.replace(/^[^0-9]*/, '');
      if (!version) return;
      if (!preview) {
        if (!isNewer(version, currentVersion)) return;
        const skipped = localStorage.getItem(SKIP_KEY);
        if (skipped === version) return;
        // Windows updates go through WinGet moderation; hold the notice until
        // the release clears the moderation window so users aren't pointed at a
        // version WinGet hasn't published yet. macOS/Linux use other channels.
        if (IS_WINDOWS && isWithinModerationWindow(data.published_at, Date.now())) return;
      }
      setDismissed(false);
      setDlState('idle');
      setRelease({
        version,
        tag,
        body: (data.body ?? '').trim(),
        assets: data.assets ?? [],
      });
      if (IS_LINUX) {
        const arch = await commands.checkArchLinux();
        setIsArch(arch);
      }
    } catch {
      // No network or rate-limited — stay idle
    }
  };

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => { if (!cancelled) fetchRelease(); }, 4000);

    const handler = () => fetchRelease(true);
    window.addEventListener('psysonic:preview-update', handler);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('psysonic:preview-update', handler);
    };
  }, []);

  // Clean up download listener when component unmounts
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      if (countdownRef.current) window.clearInterval(countdownRef.current);
    };
  }, []);

  const handleSkip = () => {
    if (!release) return;
    localStorage.setItem(SKIP_KEY, release.version);
    setDismissed(true);
  };

  const startRestartCountdown = (seconds: number) => {
    let remaining = seconds;
    setCountdown(remaining);
    countdownRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (countdownRef.current) window.clearInterval(countdownRef.current);
        countdownRef.current = null;
        setCountdown(null);
        relaunchFnRef.current?.();
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  };

  const handleRestartNow = async () => {
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdown(null);
    await relaunchFnRef.current?.();
  };

  const asset = pickAsset(release?.assets ?? []);

  const handleDownload = async () => {
    // macOS and Windows use the Tauri Updater plugin: it downloads the update
    // and verifies its minisign signature against the bundled pubkey.
    // macOS: replaces the .app in place; the process keeps running, so we
    //   relaunch it ourselves after a short countdown.
    // Windows: hands the verified installer to the OS (silent Inno Setup run,
    //   see plugins.updater.windows.installerArgs) and exits this process
    //   itself; the installer relaunches Psysonic when it is done. Nothing to
    //   do here after 'Finished' — no countdown, no relaunch().
    if (updaterPlatform) {
      setDlState('downloading');
      setDlProgress({ bytes: 0, total: 0 });
      setDlError('');
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        if (updaterPlatform === 'macos') {
          const { relaunch } = await import('@tauri-apps/plugin-process');
          relaunchFnRef.current = relaunch;
        }
        const update = await check();
        if (!update) {
          setDlError(t('common.updaterErrorMsg'));
          setDlState('error');
          return;
        }
        let downloaded = 0;
        let total = 0;
        await update.downloadAndInstall(event => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0;
            setDlProgress({ bytes: 0, total });
          } else if (event.event === 'Progress') {
            downloaded += event.data.chunkLength;
            setDlProgress({ bytes: downloaded, total });
          } else if (event.event === 'Finished') {
            setDlState('done');
            // macOS: downloadAndInstall replaces the .app in place but does not
            // exit the running process. Give the user a 3s countdown (with a
            // manual "Restart now" button) before auto-relaunch.
            if (updaterPlatform === 'macos') startRestartCountdown(3);
          }
        });
      } catch (e) {
        setDlError(String(e));
        setDlState('error');
      }
      return;
    }

    if (!asset) return;
    setDlState('downloading');
    setDlProgress({ bytes: 0, total: asset.size });
    setDlError('');

    const unlisten = await listen<{ bytes: number; total: number | null }>(
      'update:download:progress',
      e => {
        setDlProgress({
          bytes: e.payload.bytes,
          total: e.payload.total ?? asset.size,
        });
      }
    );
    unlistenRef.current = unlisten;

    try {
      const dlRes = await commands.downloadUpdate(asset.browser_download_url, asset.name);
      if (dlRes.status === 'error') throw new Error(dlRes.error);
      const finalPath = dlRes.data;
      unlisten();
      unlistenRef.current = null;
      setDlPath(finalPath);
      setDlState('done');
    } catch (e) {
      unlisten();
      unlistenRef.current = null;
      setDlError(String(e));
      setDlState('error');
    }
  };

  const handleShowFolder = async () => {
    // tauri-plugin-shell's open() only allows https:// per capability scope —
    // local paths are blocked and fail silently. Delegate to Rust instead.
    const dir = await dirname(dlPath);
    const res = await commands.openFolder(dir);
    if (res.status === 'error') throw new Error(res.error);
  };

  const showAurHint = IS_LINUX && isArch;
  // Windows can also update through WinGet once a release clears moderation
  // (the notice itself is held back for that window, see #1200). Shown next to
  // the in-app install, not instead of it — a WinGet user may prefer to keep
  // that tool in charge of the installed version.
  const showWingetHint = IS_WINDOWS;
  // Where the Tauri Updater handles download, signature verification and
  // install, the modal must not offer the raw asset (DMG / installer) as well.
  const useTauriUpdater = updaterPlatform !== null;
  const showInstallBtn = !showAurHint && (useTauriUpdater || !!asset);

  const pct = dlProgress.total > 0
    ? Math.min(100, Math.round((dlProgress.bytes / dlProgress.total) * 100))
    : 0;

  return {
    release, dismissed, setDismissed, changelogOpen, setChangelogOpen,
    dlState, dlProgress, dlError, countdown,
    asset, showAurHint, showWingetHint, updaterPlatform, useTauriUpdater, showInstallBtn, pct,
    handleSkip, handleRestartNow, handleDownload, handleShowFolder,
  };
}
