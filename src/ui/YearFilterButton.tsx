import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarRange, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import FilterQuickClear from '@/ui/FilterQuickClear';
import { tooltipAttrs } from '@/ui/tooltipAttrs';
import {
  ALBUM_YEAR_MAX,
  ALBUM_YEAR_MIN,
  commitAlbumYearDraftField,
  formatAlbumYearFilterLabel,
  normalizeAlbumYearToFieldChange,
  resolveAlbumYearBounds,
  sanitizeAlbumYearTypingInput,
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
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const fromFocusedRef = useRef(false);
  const toFocusedRef = useRef(false);

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
    if (!fromFocusedRef.current) {
      setDraftFrom(from);
    }
  }, [from]);

  useEffect(() => {
    if (!toFocusedRef.current) {
      setDraftTo(to);
    }
  }, [to]);

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

  const resolveDraftTo = useCallback((): string => {
    if (!draftTo.trim()) return '';
    if (sanitizeAlbumYearTypingInput(draftTo).length < 4) return to;
    return normalizeAlbumYearToFieldChange(to, draftTo, yMin, yMax);
  }, [draftTo, to, yMin, yMax]);

  const applyDraftsAndClose = useCallback(() => {
    fromFocusedRef.current = false;
    toFocusedRef.current = false;
    const nextFrom = commitAlbumYearDraftField(draftFrom, from, yMin, yMax);
    const nextTo = resolveDraftTo();
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    onChange(nextFrom, nextTo);
    setOpen(false);
  }, [draftFrom, from, onChange, resolveDraftTo, yMin, yMax]);

  const commitFromField = useCallback(() => {
    if (!fromFocusedRef.current) return;
    fromFocusedRef.current = false;
    const next = commitAlbumYearDraftField(draftFrom, from, yMin, yMax);
    setDraftFrom(next);
    onChange(next, to);
  }, [draftFrom, from, onChange, to, yMin, yMax]);

  const commitToField = useCallback(() => {
    if (!toFocusedRef.current) return;
    toFocusedRef.current = false;
    if (!draftTo.trim()) {
      setDraftTo('');
      onChange(from, '');
      return;
    }
    if (sanitizeAlbumYearTypingInput(draftTo).length < 4) {
      setDraftTo(to);
      return;
    }
    const next = normalizeAlbumYearToFieldChange(to, draftTo, yMin, yMax);
    setDraftTo(next);
    onChange(from, next);
  }, [draftTo, from, onChange, to, yMin, yMax]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      ) {
        applyDraftsAndClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        applyDraftsAndClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, applyDraftsAndClose]);

  const clear = () => {
    fromFocusedRef.current = false;
    toFocusedRef.current = false;
    setDraftFrom('');
    setDraftTo('');
    onChange('', '');
  };

  const handleFromChange = (raw: string) => {
    setDraftFrom(sanitizeAlbumYearTypingInput(raw));
  };

  const handleToChange = (raw: string) => {
    const sanitized = sanitizeAlbumYearTypingInput(raw);
    const spinnerTick = !draftTo.trim()
      && sanitized === String(yMin)
      && yMin !== yMax
      && sanitized.length === 4;
    if (spinnerTick) {
      const next = normalizeAlbumYearToFieldChange(to, sanitized, yMin, yMax);
      toFocusedRef.current = false;
      setDraftTo(next);
      onChange(from, next);
      return;
    }
    setDraftTo(sanitized);
  };

  const onYearFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyDraftsAndClose();
    }
  };

  const onYearWheel = (
    e: React.WheelEvent<HTMLInputElement>,
    field: 'from' | 'to',
  ) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    if (field === 'from') {
      fromFocusedRef.current = false;
      const nextFrom = stepAlbumYearField(from, delta, yMin, yMax, 'min');
      setDraftFrom(nextFrom);
      onChange(nextFrom, to);
    } else {
      toFocusedRef.current = false;
      const nextTo = stepAlbumYearField(to, delta, yMin, yMax, 'max');
      setDraftTo(nextTo);
      onChange(from, nextTo);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-surface${active ? ' btn-sort-active' : ''}`}
        onClick={() => {
          setOpen(prev => {
            const next = !prev;
            if (next) {
              setDraftFrom(from);
              setDraftTo(to);
            }
            return next;
          });
        }}
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
                  value={draftFrom}
                  onFocus={() => { fromFocusedRef.current = true; }}
                  onChange={e => handleFromChange(e.target.value)}
                  onBlur={commitFromField}
                  onKeyDown={onYearFieldKeyDown}
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
                  value={draftTo}
                  onFocus={() => { toFocusedRef.current = true; }}
                  onChange={e => handleToChange(e.target.value)}
                  onBlur={commitToField}
                  onKeyDown={onYearFieldKeyDown}
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
