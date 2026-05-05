import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  active: boolean;
  onChange: (next: boolean) => void;
  /** 'default' = icon + label, regular padding (Albums toolbar).
   *  'compact' = icon-only, 0.5rem padding (Artists view-mode buttons).
   *  'small'   = icon + label, 4px/14px padding + 12px text (AdvancedSearch tabs). */
  size?: 'default' | 'compact' | 'small';
}

export default function StarFilterButton({ active, onChange, size = 'default' }: Props) {
  const { t } = useTranslation();
  const tooltip = active ? t('common.favoritesTooltipOn') : t('common.favoritesTooltipOff');
  const activeStyle = active ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {};

  if (size === 'compact') {
    return (
      <button
        type="button"
        className={`btn btn-surface${active ? ' btn-sort-active' : ''}`}
        onClick={() => onChange(!active)}
        aria-pressed={active}
        aria-label={tooltip}
        data-tooltip={tooltip}
        data-tooltip-pos="bottom"
        style={{ padding: '0.5rem', ...activeStyle }}
      >
        <Star size={20} fill={active ? 'currentColor' : 'none'} />
      </button>
    );
  }

  if (size === 'small') {
    return (
      <button
        type="button"
        className={`btn ${active ? 'btn-primary' : 'btn-surface'}`}
        onClick={() => onChange(!active)}
        aria-pressed={active}
        data-tooltip={tooltip}
        data-tooltip-pos="bottom"
        style={{ fontSize: 12, padding: '4px 14px', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
      >
        <Star size={12} fill={active ? 'currentColor' : 'none'} />
        {t('common.favorites')}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`btn btn-surface${active ? ' btn-sort-active' : ''}`}
      onClick={() => onChange(!active)}
      aria-pressed={active}
      data-tooltip={tooltip}
      data-tooltip-pos="bottom"
      style={{
        display: 'flex', alignItems: 'center', gap: '0.4rem', ...activeStyle,
      }}
    >
      <Star size={14} fill={active ? 'currentColor' : 'none'} />
      {t('common.favorites')}
    </button>
  );
}
