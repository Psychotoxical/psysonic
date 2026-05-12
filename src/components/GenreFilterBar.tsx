import { getGenres } from '../api/subsonicGenres';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Filter, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface GenreFilterBarProps {
  selected: string[];
  onSelectionChange: (selected: string[]) => void;
}

export default function GenreFilterBar({ selected, onSelectionChange }: GenreFilterBarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [genres, setGenres] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getGenres().then(data =>
      setGenres(data.map(g => g.value).sort((a, b) => a.localeCompare(b)))
    );
  }, []);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Selected on top, then alphabetical (stable for comfortable scanning).
  const sortedGenres = useMemo(() => {
    const arr = [...genres];
    arr.sort((a, b) => {
      const sa = selectedSet.has(a) ? 0 : 1;
      const sb = selectedSet.has(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.localeCompare(b);
    });
    return arr;
  }, [genres, selectedSet]);

  const filteredGenres = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedGenres;
    return sortedGenres.filter(g => g.toLowerCase().includes(q));
  }, [sortedGenres, search]);

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
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
      >
        <Filter size={14} />
        {t('common.filterGenre')}
        {count > 0 && <span className="genre-filter-count">{count}</span>}
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
                  toggle(filteredGenres[0]);
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
              filteredGenres.map(g => {
                const isSel = selectedSet.has(g);
                return (
                  <div
                    key={g}
                    className={`genre-filter-popover__option${isSel ? ' genre-filter-popover__option--selected' : ''}`}
                    onClick={() => toggle(g)}
                    role="option"
                    aria-selected={isSel}
                  >
                    <span className="genre-filter-popover__check">
                      {isSel && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {g}
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
