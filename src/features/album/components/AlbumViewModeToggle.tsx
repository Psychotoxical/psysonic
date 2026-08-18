import { LayoutGrid, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AlbumViewMode } from '@/features/album/store/albumViewModeStore';

interface AlbumViewModeToggleProps {
  value: AlbumViewMode;
  onChange: (mode: AlbumViewMode) => void;
  /** Viewport this page scrolls; reset to top on a switch, see `select`. */
  scrollRootId: string;
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
export default function AlbumViewModeToggle({
  value,
  onChange,
  scrollRootId,
}: AlbumViewModeToggleProps) {
  const { t } = useTranslation();
  const select = (mode: AlbumViewMode) => {
    if (mode === value) return;
    // A table row is a good deal shorter than a grid row, so the same catalogue is
    // far less tall as a table. Keeping the offset would clamp it close to the new
    // bottom, where the load-more sentinel waits — switching views would quietly
    // pull another page. Starting at the top also puts the header in view.
    document.getElementById(scrollRootId)?.scrollTo({ top: 0 });
    onChange(mode);
  };
  return (
    <>
      <button
        type="button"
        className={`btn btn-surface ${value === 'grid' ? 'btn-sort-active' : ''}`}
        onClick={() => select('grid')}
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
        onClick={() => select('table')}
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
