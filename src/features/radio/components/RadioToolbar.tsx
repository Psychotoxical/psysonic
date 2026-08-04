import React from 'react';
import { useTranslation } from 'react-i18next';

export type RadioSortBy = 'manual' | 'az' | 'za' | 'newest';

interface RadioToolbarProps {
  activeFilter: string;
  onFilterChange: (f: string) => void;
}

/** Filter chips only — the sort picker sits in the page header beside the actions. */
export default function RadioToolbar({ activeFilter, onFilterChange }: RadioToolbarProps) {
  const { t } = useTranslation();
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
    </div>
  );
}
