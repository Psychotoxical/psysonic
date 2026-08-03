import { useTranslation } from 'react-i18next';
import { Check, Download, Shuffle, Sparkles } from 'lucide-react';
import { AnimatedThemeBadge } from '@/features/settings/components/AnimatedThemeBadge';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import type { RegistryTheme } from '@/lib/themes/themeRegistry';

interface Props {
  theme: RegistryTheme;
  /** Cache-busted thumbnail URL, resolved by the store. */
  thumbSrc: string;
  installed: boolean;
  active: boolean;
  busy: boolean;
  /** True when the app warns about animated themes on this machine. */
  showAnimatedBadge: boolean;
  onInstall: () => void;
  onApply: () => void;
  onShuffle: () => void;
  onEnlarge: () => void;
}

/**
 * The store's spotlight slot: one theme from further down the catalogue, offered
 * above the search box so themes that stopped being "recently changed" still get
 * discovered.
 *
 * Layout follows the Themes tab's own section pattern: an accent-icon heading
 * standing above the panel (`h3` — the tab's section titles are `h2`), and a
 * title-less `SettingsGroup` for the offset panel underneath. Deliberately more
 * compact than a store row — it must not push the catalogue off-screen.
 */
export function ThemeSpotlightCard({
  theme,
  thumbSrc,
  installed,
  active,
  busy,
  showAnimatedBadge,
  onInstall,
  onApply,
  onShuffle,
  onEnlarge,
}: Props) {
  const { t } = useTranslation();

  return (
    <>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, margin: '0 0 0.75rem' }}>
        <span style={{ display: 'inline-flex', color: 'var(--accent)' }}><Sparkles size={16} /></span>
        {t('settings.themeStoreSpotlightTitle')}
      </h3>

      <SettingsGroup>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <button
            type="button"
            onClick={onEnlarge}
            aria-label={t('settings.themeStoreEnlarge')}
            data-tooltip={t('settings.themeStoreEnlarge')}
            data-tooltip-pos="right"
            style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', flexShrink: 0, lineHeight: 0, borderRadius: 6 }}
          >
            <img
              src={thumbSrc}
              alt=""
              loading="lazy"
              width={140}
              height={79}
              onError={e => { e.currentTarget.style.opacity = '0'; }}
              style={{ width: 140, height: 79, objectFit: 'cover', borderRadius: 6, background: 'var(--bg-deep)' }}
            />
          </button>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{theme.name}</span>
              {active && (
                <span style={{ fontSize: 11, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Check size={12} /> {t('settings.themeStoreActive')}
                </span>
              )}
              {showAnimatedBadge && theme.animated && <AnimatedThemeBadge variant="inline" />}
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('settings.themeStoreByAuthor', { author: theme.author })}
              {' · '}v{theme.version}
            </div>

            <p
              style={{
                fontSize: 12.5,
                color: 'var(--text-secondary)',
                lineHeight: 1.4,
                margin: '6px 0 0',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {theme.description}
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {!installed && (
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 12, padding: '4px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  onClick={onInstall}
                  disabled={busy}
                >
                  <Download size={14} /> {busy ? t('settings.themeStoreInstalling') : t('settings.themeStoreInstall')}
                </button>
              )}
              {installed && !active && (
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 12px' }} onClick={onApply}>
                  {t('settings.themeStoreApply')}
                </button>
              )}
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '4px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                onClick={onShuffle}
              >
                <Shuffle size={14} /> {t('settings.themeStoreSpotlightShuffle')}
              </button>
            </div>
          </div>
        </div>
      </SettingsGroup>
    </>
  );
}
