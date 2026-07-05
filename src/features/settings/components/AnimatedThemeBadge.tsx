import { Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Variant = 'inline' | 'overlay';

/**
 * Small amber "animated theme" chip, shown only on animation-risk setups
 * (Nvidia/Linux or compositing off). A motion glyph rather than a hazard
 * triangle — the CPU-usage caveat lives in the tooltip.
 *
 * - `inline`  — sits after a theme name (Theme Store rows).
 * - `overlay` — pinned top-centre on an installed theme's preview swatch
 *               (top-right is the active indicator, top-left the uninstall X).
 */
export function AnimatedThemeBadge({ variant }: { variant: Variant }) {
  const { t } = useTranslation();
  const overlay = variant === 'overlay';
  return (
    <span
      role="img"
      aria-label={t('settings.themeAnimationWarning')}
      data-tooltip={t('settings.themeAnimationWarning')}
      data-tooltip-pos="top"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        width: overlay ? 18 : undefined,
        height: overlay ? 18 : undefined,
        padding: overlay ? 0 : '1px 5px',
        borderRadius: 999,
        background: 'color-mix(in srgb, var(--warning) 20%, var(--bg-elevated, var(--bg-card)))',
        border: '1px solid color-mix(in srgb, var(--warning) 45%, transparent)',
        color: 'var(--warning)',
        ...(overlay
          ? { position: 'absolute', top: 3, left: '50%', transform: 'translateX(-50%)' }
          : { verticalAlign: 'middle' }),
      }}
    >
      <Activity size={overlay ? 11 : 12} strokeWidth={2.5} />
    </span>
  );
}
