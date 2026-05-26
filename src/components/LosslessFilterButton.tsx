import { Gem } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  active: boolean;
  onChange: (next: boolean) => void;
}

export default function LosslessFilterButton({ active, onChange }: Props) {
  const { t } = useTranslation();
  const tooltip = active ? t('albums.losslessTooltipOn') : t('albums.losslessTooltipOff');
  const activeStyle = active ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {};

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
      <Gem size={14} />
      {t('albums.losslessLabel')}
    </button>
  );
}
