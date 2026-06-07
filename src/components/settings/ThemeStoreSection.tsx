import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, RefreshCw, Trash2 } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import CoverLightbox from '../CoverLightbox';
import { useThemeStore } from '../../store/themeStore';
import { useInstalledThemesStore, type InstalledTheme } from '../../store/installedThemesStore';
import {
  cdnUrl,
  fetchRegistry,
  fetchThemeCss,
  type RegistryTheme,
} from '../../utils/themes/themeRegistry';
import { validateThemeCss } from '../../utils/themes/themeInjection';
import { uninstallTheme } from '../../utils/themes/uninstallTheme';
import { isNewer } from '../../utils/componentHelpers/appUpdaterHelpers';

type ModeFilter = 'all' | 'dark' | 'light';

const THEMES_REPO_URL = 'https://github.com/Psysonic/psysonic-themes';

/**
 * The community Theme Store: browse the jsDelivr-hosted registry, filter by name
 * and light/dark, install (fetch + persist + runtime inject), apply, update and
 * uninstall. Built-in themes are not in the registry, so they never appear here.
 */
export function ThemeStoreSection() {
  const { t } = useTranslation();
  const activeTheme = useThemeStore(s => s.theme);
  const setTheme = useThemeStore(s => s.setTheme);
  const installed = useInstalledThemesStore(s => s.themes);
  const install = useInstalledThemesStore(s => s.install);

  const [themes, setThemes] = useState<RegistryTheme[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);

  const load = (force = false) => {
    setLoading(true);
    setError(false);
    fetchRegistry({ force })
      .then(r => { setThemes(r.registry.themes); setGeneratedAt(r.registry.generatedAt); setStale(r.stale); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  // Thumbnails live at a stable CDN path, so the webview caches them hard
  // (jsDelivr sends max-age 7d). Tie a cache-buster to the registry's
  // generatedAt — it changes on every themes push — so refreshed thumbnails
  // show up after a registry refresh instead of being stuck on the old image.
  const thumbUrl = (rel: string) =>
    generatedAt ? `${cdnUrl(rel)}?v=${encodeURIComponent(generatedAt)}` : cdnUrl(rel);

  useEffect(() => { load(false); }, []);

  const installedMap = useMemo(() => {
    const m = new Map<string, InstalledTheme>();
    for (const it of installed) m.set(it.id, it);
    return m;
  }, [installed]);

  const filtered = useMemo(() => {
    if (!themes) return [];
    const q = query.trim().toLowerCase();
    return themes.filter(th => {
      if (mode !== 'all' && th.mode !== mode) return false;
      if (!q) return true;
      return (
        th.name.toLowerCase().includes(q) ||
        th.author.toLowerCase().includes(q) ||
        th.description.toLowerCase().includes(q) ||
        (th.tags || []).some(tag => tag.includes(q))
      );
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [themes, query, mode]);

  const handleInstall = async (th: RegistryTheme) => {
    setBusyId(th.id);
    setFailedId(null);
    try {
      const css = await fetchThemeCss(th.css);
      // Don't persist CSS that won't inject — otherwise the theme would show as
      // installed/active but render nothing. Validate before storing.
      if (validateThemeCss(css, th.id) == null) {
        setFailedId(th.id);
        return;
      }
      install({
        id: th.id,
        name: th.name,
        author: th.author,
        version: th.version,
        description: th.description,
        mode: th.mode,
        tags: th.tags,
        css,
        installedAt: Date.now(),
      });
    } catch {
      setFailedId(th.id);
    } finally {
      setBusyId(null);
    }
  };


  const modeBtns: { key: ModeFilter; label: string }[] = [
    { key: 'all', label: t('settings.themeStoreModeAll') },
    { key: 'dark', label: t('settings.themeStoreModeDark') },
    { key: 'light', label: t('settings.themeStoreModeLight') },
  ];

  return (
    <div className="settings-card">
      {/* Submit-your-own-theme hint */}
      <div className="settings-hint settings-hint-info" style={{ marginBottom: '1rem' }}>
        {t('settings.themeStoreSubmitText')}{' '}
        <button
          type="button"
          onClick={() => void openUrl(THEMES_REPO_URL)}
          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
        >
          {t('settings.themeStoreSubmitLink')}
        </button>
      </div>

      {/* Toolbar: search + mode filter + refresh */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: '1rem' }}>
        <input
          type="search"
          className="input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('settings.themeStoreSearchPlaceholder')}
          aria-label={t('settings.themeStoreSearchPlaceholder')}
          style={{ flex: '1 1 180px', minWidth: 140 }}
        />
        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label={t('settings.themeStoreFilterMode')}>
          {modeBtns.map(b => (
            <button
              key={b.key}
              className={`btn ${mode === b.key ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: 12, padding: '4px 10px' }}
              aria-pressed={mode === b.key}
              onClick={() => setMode(b.key)}
            >
              {b.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-ghost"
          style={{ padding: '4px 10px' }}
          onClick={() => load(true)}
          disabled={loading}
          aria-label={t('settings.themeStoreRefresh')}
          data-tooltip={t('settings.themeStoreRefresh')}
          data-tooltip-pos="left"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {!loading && stale && (
        <div className="settings-hint settings-hint-info" role="status" style={{ marginBottom: '0.75rem' }}>
          {t('settings.themeStoreOffline')}
        </div>
      )}

      {loading && (
        <p role="status" style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('settings.themeStoreLoading')}</p>
      )}

      {!loading && error && (
        <div role="alert" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          <p style={{ marginBottom: 8 }}>{t('settings.themeStoreError')}</p>
          <button className="btn btn-ghost" onClick={() => load(true)}>{t('settings.themeStoreRetry')}</button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <p role="status" style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('settings.themeStoreEmpty')}</p>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(th => {
            const inst = installedMap.get(th.id);
            const isInstalled = !!inst;
            const updateAvailable = isInstalled && isNewer(th.version, inst!.version);
            const isActive = activeTheme === th.id;
            const busy = busyId === th.id;
            return (
              <div
                key={th.id}
                className="theme-store-row"
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: 12,
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  borderRadius: 'var(--radius-md, 10px)',
                  background: 'var(--bg-card)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setLightbox({ src: thumbUrl(th.thumbnail), name: th.name })}
                  aria-label={t('settings.themeStoreEnlarge')}
                  data-tooltip={t('settings.themeStoreEnlarge')}
                  data-tooltip-pos="right"
                  style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', flexShrink: 0, alignSelf: 'flex-start', lineHeight: 0, borderRadius: 6 }}
                >
                  <img
                    src={thumbUrl(th.thumbnail)}
                    alt=""
                    loading="lazy"
                    width={200}
                    height={125}
                    // Offline / missing thumbnail: hide the broken-image glyph; the
                    // image's own neutral background stands in as a placeholder.
                    onError={e => { e.currentTarget.style.opacity = '0'; }}
                    style={{ width: 200, height: 125, objectFit: 'cover', borderRadius: 6, background: 'var(--bg-deep)' }}
                  />
                </button>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{th.name}</span>
                    {isActive && (
                      <span style={{ fontSize: 11, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Check size={12} /> {t('settings.themeStoreActive')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('settings.themeStoreByAuthor', { author: th.author })}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                    {th.description}
                  </div>
                  {/* Rating slot reserved — see Theme Store roadmap (deferred). */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    {!isInstalled && (
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: 12, padding: '4px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                        onClick={() => handleInstall(th)}
                        disabled={busy}
                      >
                        <Download size={14} /> {busy ? t('settings.themeStoreInstalling') : t('settings.themeStoreInstall')}
                      </button>
                    )}
                    {isInstalled && !isActive && (
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 12, padding: '4px 12px' }}
                        onClick={() => setTheme(th.id)}
                      >
                        {t('settings.themeStoreApply')}
                      </button>
                    )}
                    {updateAvailable && (
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: 12, padding: '4px 12px' }}
                        onClick={() => handleInstall(th)}
                        disabled={busy}
                      >
                        {busy ? t('settings.themeStoreUpdating') : t('settings.themeStoreUpdate')}
                      </button>
                    )}
                    {isInstalled && (
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 12, padding: '4px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                        onClick={() => uninstallTheme(th.id)}
                      >
                        <Trash2 size={14} /> {t('settings.themeStoreUninstall')}
                      </button>
                    )}
                    {failedId === th.id && (
                      <span role="status" style={{ fontSize: 12, color: 'var(--danger)', alignSelf: 'center' }}>
                        {t('settings.themeStoreInstallFailed')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lightbox && (
        <CoverLightbox src={lightbox.src} alt={lightbox.name} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
