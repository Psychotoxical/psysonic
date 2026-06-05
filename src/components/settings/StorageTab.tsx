import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Download, FolderOpen, Trash2, X } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { selectHotCacheEntries } from '../../store/hotCacheStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineStore } from '../../store/offlineStore';
import { clearImageCache, getImageCacheSize } from '../../utils/imageCache';
import { formatBytes, snapHotCacheMb } from '../../utils/format/formatBytes';
import { getPlaybackIndexKey } from '../../utils/playback/playbackServer';
import SettingsSubSection from '../SettingsSubSection';
import CoverCacheStrategySection from './CoverCacheStrategySection';

export function StorageTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const serverId = auth.activeServerId ?? '';
  const serverIndexKey = getPlaybackIndexKey();
  const clearAllOffline = useOfflineStore(s => s.clearAll);
  const clearHotCacheDisk = useLocalPlaybackStore(s => s.purgeEphemeralDisk);
  const hotCacheEntries = useLocalPlaybackStore(s => selectHotCacheEntries(s.entries));
  const [imageCacheBytes, setImageCacheBytes] = useState<number | null>(null);
  const [libraryCacheBytes, setLibraryCacheBytes] = useState<number | null>(null);
  const [hotCacheBytes, setHotCacheBytes] = useState<number | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  const mediaDir = auth.mediaDir || null;

  const hotCacheTrackCount = useMemo(() => {
    const prefix = `${serverIndexKey || serverId}:`;
    return Object.keys(hotCacheEntries).filter(k => k.startsWith(prefix)).length;
  }, [hotCacheEntries, serverIndexKey, serverId]);

  const refreshMediaSizes = useCallback(() => {
    invoke<number>('get_media_tier_size', { tier: 'library', mediaDir })
      .then(setLibraryCacheBytes)
      .catch(() => setLibraryCacheBytes(0));
    invoke<number>('get_media_tier_size', { tier: 'ephemeral', mediaDir })
      .then(setHotCacheBytes)
      .catch(() => setHotCacheBytes(0));
  }, [mediaDir]);

  useEffect(() => {
    getImageCacheSize().then(setImageCacheBytes);
    refreshMediaSizes();
  }, [refreshMediaSizes]);

  useEffect(() => {
    if (!auth.hotCacheEnabled) return;
    refreshMediaSizes();
    const interval = window.setInterval(refreshMediaSizes, 15_000);
    return () => window.clearInterval(interval);
  }, [auth.hotCacheEnabled, refreshMediaSizes]);

  useEffect(() => {
    if (!auth.hotCacheEnabled) return;
    const handle = window.setTimeout(refreshMediaSizes, 400);
    return () => window.clearTimeout(handle);
  }, [hotCacheEntries, auth.hotCacheEnabled, refreshMediaSizes]);

  const handleClearCache = useCallback(async () => {
    setClearing(true);
    await clearImageCache();
    await clearAllOffline(serverId);
    const [imgBytes] = await Promise.all([
      getImageCacheSize(),
    ]);
    setImageCacheBytes(imgBytes);
    refreshMediaSizes();
    setShowClearConfirm(false);
    setClearing(false);
  }, [clearAllOffline, serverId, refreshMediaSizes]);

  const pickMediaDir = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t('settings.mediaDirChange', { defaultValue: t('settings.offlineDirChange') }),
    });
    if (selected && typeof selected === 'string') {
      auth.setMediaDir(selected);
      refreshMediaSizes();
    }
  };

  const pickDownloadFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('settings.pickFolderTitle') });
    if (selected && typeof selected === 'string') {
      auth.setDownloadFolder(selected);
    }
  };

  return (
    <>
      <SettingsSubSection
        title={t('settings.mediaDirTitle', { defaultValue: t('settings.offlineDirTitle') })}
        icon={<FolderOpen size={16} />}
      >
        <div className="settings-card">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
            {t('settings.mediaDirDesc', { defaultValue: t('settings.offlineDirDesc') })}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              type="text"
              readOnly
              value={auth.mediaDir || t('settings.mediaDirDefault', { defaultValue: t('settings.offlineDirDefault') })}
              style={{ flex: 1, fontSize: 13, color: auth.mediaDir ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
            />
            {auth.mediaDir && (
              <button
                className="btn btn-ghost"
                onClick={() => { auth.setMediaDir(''); refreshMediaSizes(); }}
                data-tooltip={t('settings.mediaDirClear', { defaultValue: t('settings.offlineDirClear') })}
                style={{ color: 'var(--text-muted)', flexShrink: 0 }}
              >
                <X size={16} />
              </button>
            )}
            <button className="btn btn-surface" onClick={pickMediaDir} style={{ flexShrink: 0 }}>
              <FolderOpen size={16} /> {t('settings.mediaDirChange', { defaultValue: t('settings.offlineDirChange') })}
            </button>
          </div>
          {auth.mediaDir && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>
              {t('settings.mediaDirHint', { defaultValue: t('settings.offlineDirHint') })}
            </div>
          )}
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.offlineDirTitle')}
        icon={<Download size={16} />}
      >
        <div className="settings-card">
          {(imageCacheBytes !== null || libraryCacheBytes !== null) && (
            <div style={{ fontSize: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ color: 'var(--text-secondary)' }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedImages')}</span>
                {imageCacheBytes !== null ? formatBytes(imageCacheBytes) : '…'}
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedOffline')}</span>
                {libraryCacheBytes !== null ? formatBytes(libraryCacheBytes) : '…'}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.cacheMaxLabel')}</span>
            <input
              className="input"
              type="number"
              min={100}
              max={50000}
              step={100}
              value={auth.maxCacheMb}
              onChange={e => {
                const v = Number(e.target.value);
                if (v >= 100) auth.setMaxCacheMb(v);
              }}
              style={{ width: 80, padding: '4px 8px', fontSize: 13 }}
              id="cache-size-input"
            />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>MB</span>
          </div>

          {showClearConfirm ? (
            <div style={{ background: 'color-mix(in srgb, var(--color-danger, #e53935) 10%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ marginBottom: 8, color: 'var(--text-primary)' }}>{t('settings.cacheClearWarning')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary"
                  style={{ background: 'var(--color-danger, #e53935)', fontSize: 13 }}
                  onClick={handleClearCache}
                  disabled={clearing}
                >
                  {t('settings.cacheClearConfirm')}
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setShowClearConfirm(false)} disabled={clearing}>
                  {t('settings.cacheClearCancel')}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setShowClearConfirm(true)}>
              <Trash2 size={14} /> {t('settings.cacheClearBtn')}
            </button>
          )}
        </div>
      </SettingsSubSection>

      <CoverCacheStrategySection />

      <SettingsSubSection
        title={t('settings.nextTrackBufferingTitle')}
        icon={<Download size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.hotCacheTitle')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.hotCacheDisclaimer')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.hotCacheEnabled')}>
              <input
                type="checkbox"
                checked={auth.hotCacheEnabled}
                onChange={async e => {
                  const enabled = e.target.checked;
                  if (!enabled) {
                    await clearHotCacheDisk(mediaDir);
                    setHotCacheBytes(0);
                    auth.setHotCacheEnabled(false);
                  } else {
                    auth.setHotCacheEnabled(true);
                    refreshMediaSizes();
                  }
                }}
                id="hot-cache-enabled-toggle"
              />
              <span className="toggle-track" />
            </label>
          </div>

          {auth.hotCacheEnabled && (
            <div style={{ marginTop: '1.25rem' }}>
              <div style={{ fontSize: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedHot')}</span>
                  {hotCacheBytes !== null ? formatBytes(hotCacheBytes) : '…'}
                </div>
                <div style={{ color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.hotCacheTrackCount')}</span>
                  {hotCacheTrackCount}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>{t('settings.hotCacheMaxMb')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input type="range" min={32} max={20000} step={32} value={snapHotCacheMb(auth.hotCacheMaxMb)} onChange={e => auth.setHotCacheMaxMb(parseInt(e.target.value, 10))} style={{ flex: 1, minWidth: 80, maxWidth: 200 }} id="hot-cache-max-mb-slider" />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 60 }}>{snapHotCacheMb(auth.hotCacheMaxMb)} MB</span>
                </div>
              </div>
              <div style={{ marginTop: '0.75rem' }}>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>{t('settings.hotCacheDebounce')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input type="range" min={0} max={600} step={1} value={Math.min(600, Math.max(0, auth.hotCacheDebounceSec))} onChange={e => auth.setHotCacheDebounceSec(parseInt(e.target.value, 10))} style={{ flex: 1, minWidth: 80, maxWidth: 200 }} id="hot-cache-debounce-slider" />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 80 }}>
                    {Math.min(600, Math.max(0, auth.hotCacheDebounceSec)) === 0
                      ? t('settings.hotCacheDebounceImmediate')
                      : t('settings.hotCacheDebounceSeconds', { n: Math.min(600, Math.max(0, auth.hotCacheDebounceSec)) })}
                  </span>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 13 }}
                onClick={async () => {
                  await clearHotCacheDisk(mediaDir);
                  refreshMediaSizes();
                }}
              >
                <Trash2 size={14} /> {t('settings.hotCacheClearBtn')}
              </button>
            </div>
          )}
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.downloadsTitle')}
        icon={<FolderOpen size={16} />}
      >
        <div className="settings-card">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
            {t('settings.downloadsFolderDesc')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              type="text"
              readOnly
              value={auth.downloadFolder || t('settings.downloadsDefault')}
              style={{ flex: 1, fontSize: 13, color: auth.downloadFolder ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
            />
            {auth.downloadFolder && (
              <button
                className="btn btn-ghost"
                onClick={() => auth.setDownloadFolder('')}
                aria-label={t('settings.clearFolder')}
                data-tooltip={t('settings.clearFolder')}
                style={{ color: 'var(--text-muted)', flexShrink: 0 }}
              >
                <X size={16} />
              </button>
            )}
            <button className="btn btn-surface" onClick={pickDownloadFolder} style={{ flexShrink: 0 }} id="settings-download-folder-btn">
              <FolderOpen size={16} /> {t('settings.pickFolder')}
            </button>
          </div>
        </div>
      </SettingsSubSection>
    </>
  );
}
