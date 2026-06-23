import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, Download, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import CoverLightbox from '../CoverLightbox';
import { useThemeAnimationRisk } from '../../hooks/useThemeAnimationRisk';
import { AnimatedThemeBadge } from './AnimatedThemeBadge';
import CustomSelect from '../CustomSelect';
import { formatRelativeTime } from '../../utils/format/relativeTime';
import { useThemeStore } from '../../store/themeStore';
import { useInstalledThemesStore, type InstalledTheme } from '../../store/installedThemesStore';
import {
  assetUrl,
  fetchRegistry,
  type RegistryTheme,
} from '../../utils/themes/themeRegistry';
import { installThemeFromRegistry } from '../../utils/themes/installThemeFromRegistry';
import { uninstallTheme } from '../../utils/themes/uninstallTheme';
import { isNewer } from '../../utils/componentHelpers/appUpdaterHelpers';

type ModeFilter = 'all' | 'dark' | 'light';
type SortMode = 'newest' | 'name';
type AnimFilter = 'all' | 'animated' | 'static';

const THEMES_REPO_URL = 'https://github.com/Psysonic/psysonic-themes';

/** Themes shown per page — the catalogue is large enough to paginate. */
const PAGE_SIZE = 12;

/** Page numbers for the pager: all of them when there are few, otherwise the
 *  first and last page plus a window around the current one, with gaps. */
function pageItemsList(current: number, total: number): (number | 'gap')[] {
  if (total <= 10) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | 'gap')[] = [1];
  const lo = Math.max(2, current - 2);
  const hi = Math.min(total - 1, current + 2);
  if (lo > 2) out.push('gap');
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < total - 1) out.push('gap');
  out.push(total);
  return out;
}

/**
 * The community Theme Store: browse the GitHub-hosted registry, filter by name
 * and light/dark, install (fetch + persist + runtime inject), apply, update and
 * uninstall. Built-in themes are not in the registry, so they never appear here.
 */
export function ThemeStoreSection() {
  const { t, i18n } = useTranslation();
  const activeTheme = useThemeStore(s => s.theme);
  const setTheme = useThemeStore(s => s.setTheme);
  const installed = useInstalledThemesStore(s => s.themes);
  const animRisk = useThemeAnimationRisk();

  const [themes, setThemes] = useState<RegistryTheme[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [animFilter, setAnimFilter] = useState<AnimFilter>('all');
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

  // GitHub raw caches thumbnails only briefly, but the webview can still hold an
  // old copy; tie a cache-buster to the registry's generatedAt — it changes on
  // every themes push — so refreshed thumbnails show up after a registry refresh
  // instead of being stuck on the old image.
  const thumbUrl = (rel: string) =>
    generatedAt ? `${assetUrl(rel)}?v=${encodeURIComponent(generatedAt)}` : assetUrl(rel);

  // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(false); }, []);

  const installedMap = useMemo(() => {
    const m = new Map<string, InstalledTheme>();
    for (const it of installed) m.set(it.id, it);
    return m;
  }, [installed]);

  const filtered = useMemo(() => {
    if (!themes) return [];
    const q = query.trim().toLowerCase();
    const matched = themes.filter(th => {
      if (mode !== 'all' && th.mode !== mode) return false;
      if (animFilter === 'animated' && !th.animated) return false;
      if (animFilter === 'static' && th.animated) return false;
      if (!q) return true;
      return (
        th.name.toLowerCase().includes(q) ||
        th.author.toLowerCase().includes(q) ||
        th.description.toLowerCase().includes(q) ||
        (th.tags || []).some(tag => tag.includes(q))
      );
    });
    // Name is the stable tie-breaker — keeps ordering deterministic when many
    // themes share the same last-modified date.
    const byName = (a: RegistryTheme, b: RegistryTheme) => a.name.localeCompare(b.name);
    if (sortMode === 'name') return matched.sort(byName);
    return matched.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || byName(a, b));
  }, [themes, query, mode, sortMode, animFilter]);

  // A changed filter can shrink the result set below the current page; reset to
  // the first page whenever the query or mode filter changes.
  // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPage(1); }, [query, mode, sortMode, animFilter]);

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
    const result = await installThemeFromRegistry(th);
    if (result !== 'ok') setFailedId(th.id);
    setBusyId(null);
  };


  const modeBtns: { key: ModeFilter; label: string }[] = [
    { key: 'all', label: t('settings.themeStoreModeAll') },
    { key: 'dark', label: t('settings.themeStoreModeDark') },
    { key: 'light', label: t('settings.themeStoreModeLight') },
  ];

  const sortOptions = [
    { value: 'newest', label: t('settings.themeStoreSortNewest') },
    { value: 'name', label: t('settings.themeStoreSortName') },
  ];

  const animFilterOptions = [
    { value: 'all', label: t('settings.themeStoreAnimAll') },
    { value: 'animated', label: t('settings.themeStoreAnimAnimated') },
    { value: 'static', label: t('settings.themeStoreAnimStatic') },
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

      {/* Network disclosure — the store reaches external services. */}
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 1rem', lineHeight: 1.5 }}>
        {t('settings.themeStoreNetworkNotice')}{' '}{t('settings.themeStoreStatsNotice')}
      </p>

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
        <CustomSelect
          value={sortMode}
          options={sortOptions}
          onChange={v => setSortMode(v as SortMode)}
          style={{
            width: 170,
            flexShrink: 0,
            alignSelf: 'stretch',
            boxSizing: 'border-box',
            padding: '0 var(--space-4)',
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 14,
            lineHeight: 1,
          }}
        />
        <CustomSelect
          value={animFilter}
          options={animFilterOptions}
          onChange={v => setAnimFilter(v as AnimFilter)}
          style={{
            width: 150,
            flexShrink: 0,
            alignSelf: 'stretch',
            boxSizing: 'border-box',
            padding: '0 var(--space-4)',
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 14,
            lineHeight: 1,
          }}
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
          {pageItems.map((th, idx) => {
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
                  flexWrap: 'wrap',
                  gap: 14,
                  padding: 12,
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-md, 10px)',
                  // Subtle zebra striping so adjacent rows read as distinct boxes.
                  background: idx % 2 === 1 ? 'var(--bg-hover)' : 'var(--bg-card)',
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
                    height={112}
                    // Offline / missing thumbnail: hide the broken-image glyph; the
                    // image's own neutral background stands in as a placeholder.
                    onError={e => { e.currentTarget.style.opacity = '0'; }}
                    style={{ width: 200, height: 112, objectFit: 'cover', borderRadius: 6, background: 'var(--bg-deep)' }}
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
                    {animRisk && th.animated && <AnimatedThemeBadge variant="inline" />}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('settings.themeStoreByAuthor', { author: th.author })}
                    {' · '}
                    {updateAvailable ? (
                      <>v{inst!.version} <span style={{ color: 'var(--accent)' }}>→ v{th.version}</span></>
                    ) : (
                      <>v{th.version}</>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.4, marginTop: 10 }}>
                    {th.description}
                  </div>
                  {th.updatedAt && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                      {t('settings.themeStoreLastChanged')}: {formatRelativeTime(th.updatedAt, i18n.language)}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
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
        <div
          role="navigation"
          aria-label={t('settings.themeStorePageStatus', { page: safePage, total: pageCount })}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 6, marginTop: 16 }}
        >
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
          {pageItemsList(safePage, pageCount).map((it, i) =>
            it === 'gap' ? (
              <span key={`gap-${i}`} style={{ color: 'var(--text-muted)', padding: '0 2px' }}>…</span>
            ) : (
              <button
                key={it}
                className={`btn ${it === safePage ? 'btn-primary' : 'btn-ghost'}`}
                style={{ fontSize: 12.5, padding: '4px 10px', minWidth: 34 }}
                aria-current={it === safePage ? 'page' : undefined}
                onClick={() => goToPage(it)}
              >
                {it}
              </button>
            )
          )}
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
