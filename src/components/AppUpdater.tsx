import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-shell';
import { ArrowUpCircle, CheckCircle2, ChevronDown, Download, FolderOpen, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { version as currentVersion } from '../../package.json';
import { fmtBytes } from '../utils/componentHelpers/appUpdaterHelpers';
import { useAppUpdater } from '../hooks/useAppUpdater';
import Changelog from './appUpdater/Changelog';

export default function AppUpdater() {
  const { t } = useTranslation();
  const {
    release, dismissed, setDismissed, changelogOpen, setChangelogOpen,
    dlState, dlProgress, dlError, countdown,
    asset, showAurHint, useTauriUpdater, showInstallBtn, pct,
    handleSkip, handleRestartNow, handleDownload, handleShowFolder,
  } = useAppUpdater();

  if (!release || dismissed) return null;

  return createPortal(
    <>
      <div className="eq-popup-backdrop" onClick={() => setDismissed(true)} style={{ zIndex: 3000 }} />
      <div
        className="eq-popup update-modal"
        style={{ zIndex: 3001 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="eq-popup-header update-modal-header">
          <ArrowUpCircle size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="eq-popup-title">{t('common.updaterModalTitle')}</span>
            <span className="update-modal-versions">
              v{currentVersion} → <strong>v{release.version}</strong>
            </span>
          </div>
          <button
            className="app-updater-dismiss"
            onClick={() => setDismissed(true)}
            data-tooltip={t('common.updaterRemindBtn')}
            data-tooltip-pos="bottom"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable body: changelog + download area — single overflow container */}
        <div className="update-modal-body">
          {/* Collapsible Changelog */}
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
                    {fmtBytes(dlProgress.bytes)}
                    {dlProgress.total > 0 && ` / ${fmtBytes(dlProgress.total)}`}
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
                  <span className="update-modal-asset-size">{fmtBytes(asset.size)}</span>
                </div>
              )}
              {dlState === 'downloading' && (
                <div className="update-modal-progress">
                  <div className="app-updater-progress-bar">
                    <div className="app-updater-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="app-updater-pct">{pct}%</span>
                  <span className="update-modal-dl-bytes">
                    {fmtBytes(dlProgress.bytes)}
                    {dlProgress.total > 0 && ` / ${fmtBytes(dlProgress.total)}`}
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
        </div>{/* end update-modal-body */}

        {/* Footer buttons — state-dependent to avoid redundant/jumping buttons */}
        <div className="update-modal-footer">
          {dlState === 'idle' && (
            <>
              <button className="btn btn-ghost update-modal-skip" onClick={handleSkip}>
                {t('common.updaterSkipBtn')}
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn btn-surface" onClick={() => setDismissed(true)}>
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
          )}
          {dlState === 'downloading' && <div style={{ flex: 1 }} />}
          {dlState === 'done' && useTauriUpdater && (
            <>
              <div style={{ flex: 1 }} />
              <button className="btn btn-primary" onClick={handleRestartNow}>
                <RefreshCw size={14} />
                {t('common.updaterRestartNow', { defaultValue: 'Restart now' })}
              </button>
            </>
          )}
          {dlState === 'done' && !useTauriUpdater && (
            <>
              <div style={{ flex: 1 }} />
              <button className="btn btn-surface" onClick={() => setDismissed(true)}>
                {t('common.updaterRemindBtn')}
              </button>
            </>
          )}
          {dlState === 'error' && (
            <>
              <div style={{ flex: 1 }} />
              <button className="btn btn-surface" onClick={() => setDismissed(true)}>
                {t('common.updaterRemindBtn')}
              </button>
              <button className="btn btn-primary" onClick={handleDownload}>
                {t('common.updaterRetryBtn')}
              </button>
            </>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
