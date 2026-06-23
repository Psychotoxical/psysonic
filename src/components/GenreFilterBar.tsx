import { getGenres } from '../api/subsonicGenres';
import type { GenreFilterOption } from '../utils/library/albumBrowseLoad';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Filter, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import FilterQuickClear from './FilterQuickClear';
import { tooltipAttrs } from './tooltipAttrs';

type GenreRow = GenreFilterOption;

function mergeGenreRows(
  catalogGenres: GenreFilterOption[],
  selected: string[],
): GenreRow[] {
  const byGenre = new Map<string, number>();
  for (const { genre, count } of catalogGenres) byGenre.set(genre, count);
  for (const genre of selected) {
    if (!byGenre.has(genre)) byGenre.set(genre, 0);
  }
  return [...byGenre.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre));
}

interface GenreFilterBarProps {
  selected: string[];
  onSelectionChange: (selected: string[]) => void;
  /**
   * When set, only these genres are listed (e.g. from the current non-genre filters).
   * `undefined` = full server genre list from `getGenres`.
   */
  catalogGenres?: GenreFilterOption[] | null;
}

export default function GenreFilterBar({
  selected,
  onSelectionChange,
  catalogGenres,
}: GenreFilterBarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [genreRows, setGenreRows] = useState<GenreRow[]>([]);
  const [search, setSearch] = useState('');
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (catalogGenres != null) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGenreRows(mergeGenreRows(catalogGenres, selected));
      return;
    }
    let cancelled = false;
    getGenres().then(data => {
      if (cancelled) return;
      const rows: GenreRow[] = data
        .map(g => ({ genre: g.value, count: g.albumCount ?? 0 }))
        .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre));
      setGenreRows(mergeGenreRows(rows, selected));
    });
    return () => {
      cancelled = true;
    };
  }, [catalogGenres, selected]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filteredGenres = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return genreRows;
    return genreRows.filter(({ genre }) => genre.toLowerCase().includes(q));
  }, [genreRows, search]);

  const updatePopStyle = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const WIDTH = 280;
    const MAX_H = 360;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(rect.left, 8),
      window.innerWidth - WIDTH - 8,
    );
    setPopStyle({
      position: 'fixed',
      left,
      width: WIDTH,
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + MARGIN }
        : { top: rect.bottom + MARGIN }),
      maxHeight: Math.min(MAX_H, useAbove ? spaceAbove : spaceBelow),
      zIndex: 99998,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePopStyle();
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => updatePopStyle();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      ) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (genre: string) => {
    if (selectedSet.has(genre)) onSelectionChange(selected.filter(s => s !== genre));
    else onSelectionChange([...selected, genre]);
  };

  const clear = () => {
    onSelectionChange([]);
    setSearch('');
  };

  const count = selected.length;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-surface${count > 0 ? ' btn-sort-active' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...tooltipAttrs(t('common.filterGenreTooltip'), { pos: 'bottom' })}
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
      >
        <Filter size={14} />
        <span className="toolbar-btn-label">{t('common.filterGenre')}</span>
        {count > 0 && <span className="genre-filter-count">{count}</span>}
        {count > 0 && <FilterQuickClear onActiveChip onClear={clear} />}
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="genre-filter-popover"
          style={popStyle}
          role="dialog"
        >
          <div className="genre-filter-popover__search">
            <input
              ref={inputRef}
              type="text"
              placeholder={t('common.filterSearchGenres')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && filteredGenres.length > 0) {
                  toggle(filteredGenres[0].genre);
                }
              }}
            />
          </div>

          <div className="genre-filter-popover__list">
            {filteredGenres.length === 0 ? (
              <div className="genre-filter-popover__empty">
                {t('common.filterNoGenres')}
              </div>
            ) : (
              filteredGenres.map(({ genre, count: albumCount }) => {
                const isSel = selectedSet.has(genre);
                return (
                  <div
                    key={genre}
                    className={`genre-filter-popover__option${isSel ? ' genre-filter-popover__option--selected' : ''}`}
                    onClick={() => toggle(genre)}
                    role="option"
                    aria-selected={isSel}
                  >
                    <span className="genre-filter-popover__check">
                      {isSel && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span className="genre-filter-popover__label">
                      {genre}
                    </span>
                    <span className="genre-filter-popover__album-count" aria-hidden>
                      {albumCount}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {count > 0 && (
            <div className="genre-filter-popover__footer">
              <button
                className="btn btn-ghost"
                onClick={clear}
                style={{ padding: '0.3rem 0.55rem', display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}
              >
                <X size={13} />
                {t('common.filterClear')}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
