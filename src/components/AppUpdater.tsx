import { type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { ArrowUpCircle, CheckCircle2, ChevronDown, Download, FolderOpen, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { version as currentVersion } from '../../package.json';
import { formatBytes } from '../utils/format/formatBytes';
import { useAppUpdater } from '../hooks/useAppUpdater';
import Modal from './Modal';
import Changelog from './appUpdater/Changelog';

export default function AppUpdater() {
  const { t } = useTranslation();
  const {
    release, dismissed, setDismissed, changelogOpen, setChangelogOpen,
    dlState, dlProgress, dlError, countdown,
    asset, showAurHint, showWingetHint, useTauriUpdater, showInstallBtn, pct,
    handleSkip, handleRestartNow, handleDownload, handleShowFolder,
  } = useAppUpdater();

  if (!release || dismissed) return null;

  // Footer actions — state-dependent. Downloading has no actions (no footer).
  // When there is no in-app install (AUR / from-source), "Remind me later" is the
  // primary action, so it gets the accent button; Skip stays a clear button.
  let footer: ReactNode = null;
  if (dlState === 'idle') {
    footer = (
      <>
        <button className="btn btn-surface" onClick={handleSkip}>
          {t('common.updaterSkipBtn')}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className={`btn ${showInstallBtn ? 'btn-surface' : 'btn-primary'}`}
          onClick={() => setDismissed(true)}
        >
          {t('common.updaterRemindBtn')}
        </button>
        {showInstallBtn && (
          <button className="btn btn-primary" onClick={handleDownload}>
            <Download size={14} />
            {useTauriUpdater
              ? t('common.updaterInstallNow', { defaultValue: 'Install now' })
              : t('common.updaterDownloadBtn')}
          </button>
        )}
      </>
    );
  } else if (dlState === 'done' && useTauriUpdater) {
    footer = (
      <>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={handleRestartNow}>
          <RefreshCw size={14} />
          {t('common.updaterRestartNow', { defaultValue: 'Restart now' })}
        </button>
      </>
    );
  } else if (dlState === 'done') {
    footer = (
      <>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setDismissed(true)}>
          {t('common.updaterRemindBtn')}
        </button>
      </>
    );
  } else if (dlState === 'error') {
    footer = (
      <>
        <button className="btn btn-surface" onClick={() => setDismissed(true)}>
          {t('common.updaterRemindBtn')}
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={handleDownload}>
          {t('common.updaterRetryBtn')}
        </button>
      </>
    );
  }

  return (
    <Modal
      open
      onClose={() => setDismissed(true)}
      icon={<ArrowUpCircle size={18} />}
      title={t('common.updaterModalTitle')}
      subtitle={<>v{currentVersion} → <strong>v{release.version}</strong></>}
      closeLabel={t('common.updaterRemindBtn')}
      footer={footer}
    >
      {/* Collapsible changelog */}
      {release.body && (
        <div className="update-modal-changelog">
          <button
            type="button"
            className="update-modal-changelog-toggle"
            onClick={() => setChangelogOpen(v => !v)}
          >
            <ChevronDown
              size={13}
              style={{
                transform: changelogOpen ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
                flexShrink: 0,
              }}
            />
            {t('common.updaterChangelog')}
          </button>
          {changelogOpen && (
            <div className="update-modal-changelog-body">
              <Changelog body={release.body} />
            </div>
          )}
        </div>
      )}

      {/* Download / AUR area */}
      <div className="update-modal-download-area">
        {showAurHint ? (
          <div className="update-modal-aur">
            <div className="update-modal-aur-title">{t('common.updaterAurHint')}</div>
            <code className="update-modal-aur-cmd">yay -S psysonic-bin</code>
            <code className="update-modal-aur-cmd update-modal-aur-alt">sudo pacman -Syu psysonic-bin</code>
          </div>
        ) : useTauriUpdater ? (
          <>
            {dlState === 'idle' && (
              <div className="update-modal-mac-info">
                <div className="update-modal-mac-info-main">
                  {t('common.updaterMacReadyTitle', { defaultValue: 'Ready to install' })}
                </div>
                <div className="update-modal-mac-info-sub">
                  {t('common.updaterMacReady', {
                    defaultValue: 'The update downloads, verifies and applies in place — no DMG needed. The app restarts automatically when done.',
                  })}
                </div>
                <div className="update-modal-trust-badges">
                  <span className="update-modal-trust-badge">
                    <ShieldCheck size={12} />
                    {t('common.updaterTrustNotarized', { defaultValue: 'Notarized by Apple' })}
                  </span>
                  <span className="update-modal-trust-badge">
                    <CheckCircle2 size={12} />
                    {t('common.updaterTrustSignature', { defaultValue: 'Signature verified' })}
                  </span>
                </div>
              </div>
            )}
            {dlState === 'downloading' && (
              <div className="update-modal-progress">
                <div className="app-updater-progress-bar">
                  <div className="app-updater-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="app-updater-pct">{pct}%</span>
                <span className="update-modal-dl-bytes">
                  {formatBytes(dlProgress.bytes)}
                  {dlProgress.total > 0 && ` / ${formatBytes(dlProgress.total)}`}
                </span>
              </div>
            )}
            {dlState === 'done' && (
              <div className="update-modal-done">
                <CheckCircle2 size={32} className="update-modal-done-icon" />
                <div className="update-modal-done-title">
                  {t('common.updaterMacDoneTitle', { defaultValue: 'Update installed' })}
                </div>
                <div className="update-modal-done-countdown">
                  {countdown !== null
                    ? t('common.updaterRestartingIn', { defaultValue: 'Restarting in {{n}}s…', n: countdown })
                    : t('common.updaterRestarting', { defaultValue: 'Restarting…' })}
                </div>
              </div>
            )}
            {dlState === 'error' && (
              <div className="app-updater-error">{dlError || t('common.updaterErrorMsg')}</div>
            )}
          </>
        ) : asset ? (
          <>
            {dlState === 'idle' && (
              <div className="update-modal-asset">
                <span className="update-modal-asset-name">{asset.name}</span>
                <span className="update-modal-asset-size">{formatBytes(asset.size)}</span>
              </div>
            )}
            {dlState === 'idle' && showWingetHint && (
              <div className="update-modal-winget">
                <div className="update-modal-winget-title">{t('common.updaterWingetHint')}</div>
                <code className="update-modal-winget-cmd">winget upgrade Psysonic</code>
              </div>
            )}
            {dlState === 'downloading' && (
              <div className="update-modal-progress">
                <div className="app-updater-progress-bar">
                  <div className="app-updater-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="app-updater-pct">{pct}%</span>
                <span className="update-modal-dl-bytes">
                  {formatBytes(dlProgress.bytes)}
                  {dlProgress.total > 0 && ` / ${formatBytes(dlProgress.total)}`}
                </span>
              </div>
            )}
            {dlState === 'done' && (
              <div className="update-modal-done">
                <div className="update-modal-done-title">{t('common.updaterDone')}</div>
                <div className="update-modal-done-hint">{t('common.updaterInstallHint')}</div>
                <button className="btn btn-surface update-modal-folder-btn" onClick={handleShowFolder}>
                  <FolderOpen size={14} />
                  {t('common.updaterShowFolder')}
                </button>
              </div>
            )}
            {dlState === 'error' && (
              <div className="app-updater-error">{dlError || t('common.updaterErrorMsg')}</div>
            )}
          </>
        ) : (
          <div className="update-modal-asset-none">
            <button
              className="app-updater-btn-primary"
              onClick={() => open(`https://github.com/Psychotoxical/psysonic/releases/tag/${release.tag}`)}
            >
              {t('common.updaterOpenGitHub')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
