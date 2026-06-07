import { AlertTriangle, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '../../store/themeStore';
import { useInstalledThemesStore } from '../../store/installedThemesStore';
import { uninstallTheme } from '../../utils/themes/uninstallTheme';
import { useThemeAnimationRisk } from '../../hooks/useThemeAnimationRisk';
import { FIXED_THEMES } from './fixedThemes';

/** Pull a 3-band swatch (bg / card / accent) out of an installed theme's CSS. */
function swatch(css: string): { bg: string; card: string; accent: string } {
  const read = (name: string, fallback: string) => {
    const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : fallback;
  };
  return {
    bg: read('bg-app', '#1e1e2e'),
    card: read('bg-card', '#313244'),
    accent: read('accent', '#cba6f7'),
  };
}

interface Card {
  id: string;
  label: string;
  bg: string;
  card: string;
  accent: string;
  fixed: boolean;
  accessibility: boolean;
  animated: boolean;
}

/**
 * Flat card grid of the user's available themes: the fixed cores plus every
 * installed community theme. Click a card to apply it; community themes carry an
 * uninstall control (the fixed cores do not). No accordion — this page is only
 * about themes, so everything is shown at once.
 */
export function InstalledThemes() {
  const { t } = useTranslation();
  const active = useThemeStore(s => s.theme);
  const setTheme = useThemeStore(s => s.setTheme);
  const installed = useInstalledThemesStore(s => s.themes);
  const animRisk = useThemeAnimationRisk();

  const cards: Card[] = [
    ...FIXED_THEMES.map(f => ({ id: f.id, label: f.label, bg: f.bg, card: f.card, accent: f.accent, fixed: true, accessibility: !!f.accessibility, animated: false })),
    ...installed.map(it => {
      const s = swatch(it.css);
      return { id: it.id, label: it.name, bg: s.bg, card: s.card, accent: s.accent, fixed: false, accessibility: (it.tags || []).includes('accessibility'), animated: /@(?:-[a-z]+-)?keyframes\b/i.test(it.css) };
    }),
  ];

  return (
    <div className="settings-card">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: '10px' }}>
        {cards.map(c => {
          const isActive = active === c.id;
          return (
            <div key={c.id} style={{ position: 'relative' }}>
              <button className="theme-card-btn" style={{ width: '100%' }} aria-pressed={isActive} onClick={() => setTheme(c.id)}>
                <div className={`theme-card-preview${isActive ? ' is-active' : ''}`}>
                  <div style={{ background: c.bg, height: '55%' }} />
                  <div style={{ background: c.card, height: '20%' }} />
                  <div style={{ background: c.accent, height: '25%' }} />
                  {isActive && (
                    <div style={{
                      position: 'absolute',
                      top: '4px',
                      right: '4px',
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      background: c.accent,
                      border: '1.5px solid rgba(255,255,255,0.7)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <Check size={8} strokeWidth={3} color="white" />
                    </div>
                  )}
                </div>
                <span className={`theme-card-label${isActive ? ' is-active' : ''}`}>
                  {c.label}
                </span>
                {c.accessibility && (
                  <span
                    aria-label={t('settings.themesCvdTooltip')}
                    data-tooltip={t('settings.themesCvdTooltip')}
                    data-tooltip-pos="top"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      lineHeight: 1,
                      padding: '2px 6px',
                      borderRadius: 999,
                      background: 'var(--accent-dim)',
                      color: 'var(--accent)',
                      letterSpacing: 0.3,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    CVD-safe
                  </span>
                )}
                {animRisk && c.animated && (
                  <span
                    role="img"
                    aria-label={t('settings.themeAnimationWarning')}
                    data-tooltip={t('settings.themeAnimationWarning')}
                    data-tooltip-pos="top"
                    style={{ display: 'inline-flex', color: 'var(--warning)', marginTop: 2 }}
                  >
                    <AlertTriangle size={12} />
                  </span>
                )}
              </button>
              {!c.fixed && (
                <button
                  onClick={() => uninstallTheme(c.id)}
                  aria-label={t('settings.themeStoreUninstall')}
                  data-tooltip={t('settings.themeStoreUninstall')}
                  data-tooltip-pos="top"
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: 2,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
