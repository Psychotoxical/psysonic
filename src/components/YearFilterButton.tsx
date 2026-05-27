import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarRange, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import FilterQuickClear from './FilterQuickClear';
import { formatAlbumYearFilterLabel, resolveAlbumYearBounds } from '../utils/library/albumYearFilter';

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

const CURRENT_YEAR = new Date().getFullYear();

export default function YearFilterButton({ from, to, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);

  const { active, bounds } = resolveAlbumYearBounds(from, to);
  const activeLabel = formatAlbumYearFilterLabel(bounds);

  const updatePopStyle = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const WIDTH = 260;
    const MAX_H = 200;
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
    setTimeout(() => fromRef.current?.focus(), 0);
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

  const clear = () => {
    onChange('', '');
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-surface${active ? ' btn-sort-active' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          ...(active ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}),
        }}
      >
        <CalendarRange size={14} />
        {active && activeLabel ? activeLabel : t('albums.yearFilterLabel')}
        {active && <FilterQuickClear onActiveChip onClear={clear} />}
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="genre-filter-popover"
          style={popStyle}
          role="dialog"
        >
          <div style={{ padding: '0.75rem 0.75rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '0.2rem' }}>
                <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {t('albums.yearFrom')}
                </label>
                <input
                  ref={fromRef}
                  className="input"
                  type="number"
                  min={1900}
                  max={CURRENT_YEAR}
                  placeholder="1970"
                  value={from}
                  onChange={e => onChange(e.target.value, to)}
                />
              </div>
              <span style={{ alignSelf: 'flex-end', paddingBottom: '0.4rem', color: 'var(--text-muted)' }}>–</span>
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '0.2rem' }}>
                <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {t('albums.yearTo')}
                </label>
                <input
                  className="input"
                  type="number"
                  min={1900}
                  max={CURRENT_YEAR}
                  placeholder={String(CURRENT_YEAR)}
                  value={to}
                  onChange={e => onChange(from, e.target.value)}
                />
              </div>
            </div>
          </div>

          {active && (
            <div className="genre-filter-popover__footer">
              <button
                className="btn btn-ghost"
                onClick={clear}
                style={{ padding: '0.3rem 0.55rem', display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}
              >
                <X size={13} />
                {t('albums.yearFilterClear')}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
