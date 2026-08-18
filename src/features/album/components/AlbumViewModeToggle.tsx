import { LayoutGrid, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AlbumViewMode } from '@/features/album/store/albumViewModeStore';

interface AlbumViewModeToggleProps {
  value: AlbumViewMode;
  onChange: (mode: AlbumViewMode) => void;
}

const ACTIVE_STYLE = {
  background: 'var(--accent)',
  color: 'var(--text-on-accent)',
  padding: '0.5rem',
} as const;

const IDLE_STYLE = { padding: '0.5rem' } as const;

/**
 * Grid/table switch for the album catalogue pages. Deliberately mirrors the
 * artist/composer view switch in markup and styling — same shared button
 * classes, same icons, same placement in the filter bar — so the two controls
 * do not read as different mechanisms.
 */
export default function AlbumViewModeToggle({ value, onChange }: AlbumViewModeToggleProps) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        className={`btn btn-surface ${value === 'grid' ? 'btn-sort-active' : ''}`}
        onClick={() => onChange('grid')}
        style={value === 'grid' ? ACTIVE_STYLE : IDLE_STYLE}
        aria-pressed={value === 'grid'}
        data-tooltip={t('albums.gridView')}
        data-tooltip-pos="bottom"
      >
        <LayoutGrid size={20} />
      </button>
      <button
        type="button"
        className={`btn btn-surface ${value === 'table' ? 'btn-sort-active' : ''}`}
        onClick={() => onChange('table')}
        style={value === 'table' ? ACTIVE_STYLE : IDLE_STYLE}
        aria-pressed={value === 'table'}
        data-tooltip={t('albums.tableView')}
        data-tooltip-pos="bottom"
      >
        <List size={20} />
      </button>
    </>
  );
}
