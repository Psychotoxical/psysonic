import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  onClear: () => void;
  /** Parent filter chip uses accent background (`btn-sort-active`). */
  onActiveChip?: boolean;
}

/** Inline dismiss control on toolbar filter buttons (does not open the filter popover). */
export default function FilterQuickClear({ onClear, onActiveChip = false }: Props) {
  const { t } = useTranslation();

  const activate = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onClear();
  };

  return (
    <span
      role="button"
      tabIndex={0}
      className={`filter-quick-clear${onActiveChip ? ' filter-quick-clear--on-active-chip' : ''}`}
      aria-label={t('common.filterClear')}
      onClick={activate}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') activate(e);
      }}
    >
      <X size={12} strokeWidth={2.5} aria-hidden />
    </span>
  );
}
