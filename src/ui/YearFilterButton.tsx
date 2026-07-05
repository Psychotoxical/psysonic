import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarRange, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import FilterQuickClear from '@/ui/FilterQuickClear';
import { tooltipAttrs } from '@/ui/tooltipAttrs';
import {
  ALBUM_YEAR_MAX,
  ALBUM_YEAR_MIN,
  clampAlbumYearFieldInput,
  formatAlbumYearFilterLabel,
  normalizeAlbumYearToFieldChange,
  resolveAlbumYearBounds,
  stepAlbumYearField,
} from '@/lib/library/albumYearFilter';

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  /** When set, spinners are limited to the indexed catalog (from `library_get_catalog_year_bounds`). */
  catalogMinYear?: number;
  catalogMaxYear?: number;
}

export default function YearFilterButton({
  from,
  to,
  onChange,
  catalogMinYear,
  catalogMaxYear,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);

  const yMin = catalogMinYear ?? ALBUM_YEAR_MIN;
  const yMax = catalogMaxYear ?? ALBUM_YEAR_MAX;

  const { active, bounds } = resolveAlbumYearBounds(from, to);
  const activeLabel = formatAlbumYearFilterLabel(bounds, { min: yMin, max: yMax });

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

  const handleFromChange = (raw: string) => {
    onChange(clampAlbumYearFieldInput(raw, yMin, yMax), to);
  };

  const handleToChange = (raw: string) => {
    onChange(from, normalizeAlbumYearToFieldChange(to, raw, yMin, yMax));
  };

  const onYearWheel = (
    e: React.WheelEvent<HTMLInputElement>,
    field: 'from' | 'to',
  ) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    if (field === 'from') {
      onChange(stepAlbumYearField(from, delta, yMin, yMax, 'min'), to);
    } else {
      onChange(from, stepAlbumYearField(to, delta, yMin, yMax, 'max'));
    }
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
        {...tooltipAttrs(t('albums.yearFilterTooltip'), { pos: 'bottom' })}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          ...(active ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : {}),
        }}
      >
        <CalendarRange size={14} />
        <span className="toolbar-btn-label">{active && activeLabel ? activeLabel : t('albums.yearFilterLabel')}</span>
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
                  min={yMin}
                  max={yMax}
                  placeholder={String(yMin)}
                  value={from}
                  onChange={e => handleFromChange(e.target.value)}
                  onWheel={e => onYearWheel(e, 'from')}
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
                  min={yMin}
                  max={yMax}
                  placeholder={String(yMax)}
                  value={to}
                  onChange={e => handleToChange(e.target.value)}
                  onWheel={e => onYearWheel(e, 'to')}
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
