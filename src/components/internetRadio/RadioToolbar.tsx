import React from 'react';
import { useTranslation } from 'react-i18next';
import CustomSelect from '../CustomSelect';

export type RadioSortBy = 'manual' | 'az' | 'za' | 'newest';

interface RadioToolbarProps {
  sortBy: RadioSortBy;
  activeFilter: string;
  onSortChange: (s: RadioSortBy) => void;
  onFilterChange: (f: string) => void;
}

export default function RadioToolbar({ sortBy, activeFilter, onSortChange, onFilterChange }: RadioToolbarProps) {
  const { t } = useTranslation();
  const sortOptions = [
    { value: 'manual', label: t('radio.sortManual') },
    { value: 'az',     label: t('radio.sortAZ') },
    { value: 'za',     label: t('radio.sortZA') },
    { value: 'newest', label: t('radio.sortNewest') },
  ];
  return (
    <div className="radio-toolbar">
      <div className="radio-toolbar-chips">
        {(['all', 'favorites'] as const).map(f => (
          <button
            key={f}
            className={`radio-filter-chip${activeFilter === f ? ' active' : ''}`}
            onClick={() => onFilterChange(f)}
          >
            {f === 'all' ? t('radio.filterAll') : t('radio.filterFavorites')}
          </button>
        ))}
      </div>
      <CustomSelect
        value={sortBy}
        options={sortOptions}
        onChange={v => onSortChange(v as RadioSortBy)}
        style={{ width: 'max-content', minWidth: 130, maxWidth: 220, flexShrink: 0 }}
      />
    </div>
  );
}
