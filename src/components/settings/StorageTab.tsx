import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Download, FolderOpen, Trash2, X } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useHotCacheStore } from '../../store/hotCacheStore';
import { useOfflineStore } from '../../store/offlineStore';
import { usePlayerStore } from '../../store/playerStore';
import { clearImageCache, getImageCacheSize } from '../../utils/imageCache';
import { formatBytes, snapHotCacheMb } from '../../utils/format/formatBytes';
import { showToast } from '../../utils/ui/toast';
import SettingsSubSection from '../SettingsSubSection';

export function StorageTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const serverId = auth.activeServerId ?? '';
  const clearAllOffline = useOfflineStore(s => s.clearAll);
  const clearHotCacheDisk = useHotCacheStore(s => s.clearAllDisk);
  const hotCacheEntries = useHotCacheStore(s => s.entries);
  const [imageCacheBytes, setImageCacheBytes] = useState<number | null>(null);
  const [offlineCacheBytes, setOfflineCacheBytes] = useState<number | null>(null);
  const [hotCacheBytes, setHotCacheBytes] = useState<number | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  const hotCacheTrackCount = useMemo(() => {
    const prefix = `${serverId}:`;
    return Object.keys(hotCacheEntries).filter(k => k.startsWith(prefix)).length;
  }, [hotCacheEntries, serverId]);

  // Load all three size readouts on mount.
  useEffect(() => {
    getImageCacheSize().then(setImageCacheBytes);
    invoke<number>('get_offline_cache_size', { customDir: auth.offlineDownloadDir || null }).then(setOfflineCacheBytes).catch(() => setOfflineCacheBytes(0));
    invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null }).then(setHotCacheBytes).catch(() => setHotCacheBytes(0));
  }, [auth.offlineDownloadDir, auth.hotCacheDownloadDir]);

  /** Live disk usage for hot cache (interval + refresh when index changes). */
  useEffect(() => {
    const customDir = auth.hotCacheDownloadDir || null;
    const refresh = () => {
      invoke<number>('get_hot_cache_size', { customDir })
        .then(setHotCacheBytes)
        .catch(() => setHotCacheBytes(0));
    };
    refresh();
    if (!auth.hotCacheEnabled) return;
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  }, [auth.hotCacheEnabled, auth.hotCacheDownloadDir]);

  useEffect(() => {
    if (!auth.hotCacheEnabled) return;
    const handle = window.setTimeout(() => {
      invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null })
        .then(setHotCacheBytes)
        .catch(() => setHotCacheBytes(0));
    }, 400);
    return () => window.clearTimeout(handle);
  }, [hotCacheEntries, auth.hotCacheEnabled, auth.hotCacheDownloadDir]);

  const handleClearCache = useCallback(async () => {
    setClearing(true);
    await clearImageCache();
    await clearAllOffline(serverId);
    const [imgBytes, offBytes] = await Promise.all([
      getImageCacheSize(),
      invoke<number>('get_offline_cache_size', { customDir: auth.offlineDownloadDir || null }).catch(() => 0),
    ]);
    setImageCacheBytes(imgBytes);
    setOfflineCacheBytes(offBytes);
    setShowClearConfirm(false);
    setClearing(false);
  }, [clearAllOffline, serverId, auth.offlineDownloadDir]);

  const handleClearWaveformCache = useCallback(async () => {
    setClearing(true);
    try {
      const deleted = await invoke<number>('analysis_delete_all_waveforms');
      usePlayerStore.setState({
        waveformBins: null,
      });
      showToast(
        t('settings.waveformCacheCleared', { count: deleted }),
        3500,
        'success',
      );
    } catch (e) {
      console.error(e);
      showToast(t('settings.waveformCacheClearFailed'), 4500, 'error');
    } finally {
      setClearing(false);
    }
  }, [t]);

  const pickOfflineDir = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('settings.offlineDirChange') });
    if (selected && typeof selected === 'string') {
      auth.setOfflineDownloadDir(selected);
    }
  };

  const pickHotCacheDir = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('settings.hotCacheDirChange') });
    if (selected && typeof selected === 'string') {
      auth.setHotCacheDownloadDir(selected);
      useHotCacheStore.setState({ entries: {} });
      invoke<number>('get_hot_cache_size', { customDir: selected }).then(setHotCacheBytes).catch(() => setHotCacheBytes(0));
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
      {/* Offline Library (In-App) — includes cache settings */}
      <SettingsSubSection
        title={t('settings.offlineDirTitle')}
        icon={<Download size={16} />}
      >
        <div className="settings-card">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
            {t('settings.offlineDirDesc')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              type="text"
              readOnly
              value={auth.offlineDownloadDir || t('settings.offlineDirDefault')}
              style={{ flex: 1, fontSize: 13, color: auth.offlineDownloadDir ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
            />
            {auth.offlineDownloadDir && (
              <button
                className="btn btn-ghost"
                onClick={() => auth.setOfflineDownloadDir('')}
                data-tooltip={t('settings.offlineDirClear')}
                style={{ color: 'var(--text-muted)', flexShrink: 0 }}
              >
                <X size={16} />
              </button>
            )}
            <button className="btn btn-surface" onClick={pickOfflineDir} style={{ flexShrink: 0 }} id="settings-offline-dir-btn">
              <FolderOpen size={16} /> {t('settings.offlineDirChange')}
            </button>
          </div>
          {auth.offlineDownloadDir && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>
              {t('settings.offlineDirHint')}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />

          {(imageCacheBytes !== null || offlineCacheBytes !== null) && (
            <div style={{ fontSize: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ color: 'var(--text-secondary)' }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedImages')}</span>
                {imageCacheBytes !== null ? formatBytes(imageCacheBytes) : '…'}
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedOffline')}</span>
                {offlineCacheBytes !== null ? formatBytes(offlineCacheBytes) : '…'}
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
          <div style={{ marginTop: 8 }}>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 13 }}
              onClick={handleClearWaveformCache}
              disabled={clearing}
            >
              <Trash2 size={14} /> {t('settings.waveformCacheClearBtn')}
            </button>
          </div>
        </div>
      </SettingsSubSection>

      {/* Buffering */}
      <SettingsSubSection
        title={t('settings.nextTrackBufferingTitle')}
        icon={<Download size={16} />}
      >
        <div className="settings-card">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
            {t('settings.preloadHotCacheMutualExclusive')}
          </div>

          {/* Preload mode */}
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.preloadMode')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.preloadModeDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.preloadMode')}>
              <input
                type="checkbox"
                checked={auth.preloadMode !== 'off'}
                onChange={e => {
                  if (e.target.checked) {
                    auth.setPreloadMode('balanced');
                    if (auth.hotCacheEnabled) auth.setHotCacheEnabled(false);
                  } else {
                    auth.setPreloadMode('off');
                  }
                }}
              />
              <span className="toggle-track" />
            </label>
          </div>
          {auth.preloadMode !== 'off' && (
            <>
              <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                {(['balanced', 'early', 'custom'] as const).map(mode => (
                  <button
                    key={mode}
                    className={`btn ${auth.preloadMode === mode ? 'btn-primary' : 'btn-surface'}`}
                    style={{ fontSize: 12, padding: '3px 12px' }}
                    onClick={() => auth.setPreloadMode(mode)}
                  >
                    {t(`settings.preload${mode.charAt(0).toUpperCase() + mode.slice(1)}` as any)}
                  </button>
                ))}
              </div>
              {auth.preloadMode === 'custom' && (
                <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <input
                    type="range"
                    min={5} max={120} step={5}
                    value={auth.preloadCustomSeconds}
                    onChange={e => auth.setPreloadCustomSeconds(parseInt(e.target.value))}
                    style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 36 }}>
                    {t('settings.preloadCustomSeconds', { n: auth.preloadCustomSeconds })}
                  </span>
                </div>
              )}
            </>
          )}

          <div className="divider" />

          {/* Hot Cache */}
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
                    await clearHotCacheDisk(auth.hotCacheDownloadDir || null);
                    setHotCacheBytes(0);
                    auth.setHotCacheEnabled(false);
                  } else {
                    auth.setHotCacheEnabled(true);
                    if (auth.preloadMode !== 'off') auth.setPreloadMode('off');
                    invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null })
                      .then(setHotCacheBytes)
                      .catch(() => setHotCacheBytes(0));
                  }
                }}
                id="hot-cache-enabled-toggle"
              />
              <span className="toggle-track" />
            </label>
          </div>

          {auth.hotCacheEnabled && (
            <div style={{ marginTop: '1.25rem' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  className="input"
                  type="text"
                  readOnly
                  value={auth.hotCacheDownloadDir || t('settings.hotCacheDirDefault')}
                  style={{ flex: 1, minWidth: 0, fontSize: 13, color: auth.hotCacheDownloadDir ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
                />
                {auth.hotCacheDownloadDir && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      auth.setHotCacheDownloadDir('');
                      useHotCacheStore.setState({ entries: {} });
                      invoke<number>('get_hot_cache_size', { customDir: null }).then(setHotCacheBytes).catch(() => setHotCacheBytes(0));
                    }}
                    data-tooltip={t('settings.hotCacheDirClear')}
                    style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                  >
                    <X size={16} />
                  </button>
                )}
                <button type="button" className="btn btn-surface" onClick={pickHotCacheDir} style={{ flexShrink: 0 }}>
                  <FolderOpen size={16} /> {t('settings.hotCacheDirChange')}
                </button>
              </div>
              {auth.hotCacheDownloadDir && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>
                  {t('settings.hotCacheDirHint')}
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />

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
                  await clearHotCacheDisk(auth.hotCacheDownloadDir || null);
                  const b = await invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null }).catch(() => 0);
                  setHotCacheBytes(b);
                }}
              >
                <Trash2 size={14} /> {t('settings.hotCacheClearBtn')}
              </button>
            </div>
          )}

        </div>
      </SettingsSubSection>

      {/* ZIP Export & Archiving */}
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
