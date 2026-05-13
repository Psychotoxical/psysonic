import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';

interface Props {
  filterText: string;
  setFilterText: (v: string) => void;
}

export default function PlaylistFilterToolbar({ filterText, setFilterText }: Props) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', flex: '1 1 160px', maxWidth: 260 }}>
        <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input
          className="input-search"
          style={{ width: '100%', paddingRight: filterText ? 28 : undefined }}
          placeholder={t('albumDetail.filterSongs')}
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
        />
        {filterText && (
          <button
            style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setFilterText('')}
            aria-label="Clear filter"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
