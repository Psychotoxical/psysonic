import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, Download, RefreshCw, Trash2, WifiOff } from 'lucide-react';
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

/** Themes shown per page — the catalogue is large enough to paginate. */
const PAGE_SIZE = 12;

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
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  // A manual refresh must not unmount the list: blanking it collapses the
  // scroll viewport's content height, which clamps scrollTop to 0 — i.e. the
  // page jumps to the top. So keep the existing list mounted (`refreshing`,
  // shown only via the spinning icon) and reserve the full-page loading/error
  // placeholders for the initial load, when there is nothing to show anyway.
  const load = (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(false);
    fetchRegistry({ force })
      .then(r => { setThemes(r.registry.themes); setGeneratedAt(r.registry.generatedAt); setStale(r.stale); })
      .catch(() => { if (force) setStale(true); else setError(true); })
      .finally(() => { setLoading(false); setRefreshing(false); });
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

  // A changed filter can shrink the result set below the current page; reset to
  // the first page whenever the query or mode filter changes.
  useEffect(() => { setPage(1); }, [query, mode]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp defensively so a stale `page` (e.g. after the registry shrank) never
  // points past the end and shows a blank list.
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const goToPage = (n: number) => {
    setPage(Math.min(Math.max(1, n), pageCount));
    // Start the new page from the top of the store instead of mid-scroll.
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

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

      {/* Toolbar: search + mode filter + refresh. Hidden when offline with no
          catalogue to browse — the offline banner below stands in for it. */}
      {!error && (
      <div ref={topRef} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: '1rem', scrollMarginTop: 8 }}>
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
          disabled={loading || refreshing}
          aria-label={t('settings.themeStoreRefresh')}
          data-tooltip={t('settings.themeStoreRefresh')}
          data-tooltip-pos="left"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      )}

      {!loading && stale && (
        <div className="settings-hint settings-hint-info" role="status" style={{ marginBottom: '0.75rem' }}>
          {t('settings.themeStoreOffline')}
        </div>
      )}

      {loading && (
        <p role="status" style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('settings.themeStoreLoading')}</p>
      )}

      {!loading && error && (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 12,
            padding: '28px 16px',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-md, 10px)',
            background: 'var(--bg-elevated)',
          }}
        >
          <WifiOff size={28} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{t('settings.themeStoreOfflineTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('settings.themeStoreError')}</div>
          </div>
          <button className="btn btn-ghost" onClick={() => load(true)} disabled={refreshing}>
            {t('settings.themeStoreRetry')}
          </button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <p role="status" style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('settings.themeStoreEmpty')}</p>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pageItems.map(th => {
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

      {!loading && !error && pageCount > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 16 }}>
          <button
            className="btn btn-ghost"
            style={{ padding: '4px 10px' }}
            onClick={() => goToPage(safePage - 1)}
            disabled={safePage <= 1}
            aria-label={t('settings.themeStorePagePrev')}
            data-tooltip={t('settings.themeStorePagePrev')}
            data-tooltip-pos="top"
          >
            <ChevronLeft size={16} />
          </button>
          <span role="status" style={{ fontSize: 12.5, color: 'var(--text-muted)', minWidth: 96, textAlign: 'center' }}>
            {t('settings.themeStorePageStatus', { page: safePage, total: pageCount })}
          </span>
          <button
            className="btn btn-ghost"
            style={{ padding: '4px 10px' }}
            onClick={() => goToPage(safePage + 1)}
            disabled={safePage >= pageCount}
            aria-label={t('settings.themeStorePageNext')}
            data-tooltip={t('settings.themeStorePageNext')}
            data-tooltip-pos="top"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {lightbox && (
        <CoverLightbox src={lightbox.src} alt={lightbox.name} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
