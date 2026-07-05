import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownUp, Check } from 'lucide-react';
import { tooltipAttrs } from '@/ui/tooltipAttrs';

export interface SortOption<V extends string> {
  value: V;
  label: string;
}

interface Props<V extends string> {
  value: V;
  options: SortOption<V>[];
  onChange: (value: V) => void;
  ariaLabel?: string;
  /** Hover tooltip describing the action (shown below the trigger). */
  tooltip?: string;
  /**
   * Horizontal anchor of the popover. `right` opens it leftwards (right edge
   * aligned to the trigger) — use it when the trigger is docked to the right,
   * e.g. next to an open side panel, so the popover never opens off-screen.
   */
  align?: 'left' | 'right';
}

export default function SortDropdown<V extends string>({ value, options, onChange, ariaLabel, tooltip, align = 'left' }: Props<V>) {
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const current = options.find(o => o.value === value);

  const updatePopStyle = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const WIDTH = Math.max(rect.width, 220);
    const MAX_H = 300;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const anchorLeft = align === 'right' ? rect.right - WIDTH : rect.left;
    const left = Math.min(
      Math.max(anchorLeft, 8),
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
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopStyle();
  }, [open, updatePopStyle]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => updatePopStyle();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, updatePopStyle]);

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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-surface"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        {...(tooltip ? tooltipAttrs(tooltip, { pos: 'bottom' }) : {})}
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
      >
        <ArrowDownUp size={14} />
        <span className="toolbar-btn-label">{current?.label ?? value}</span>
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="genre-filter-popover"
          style={popStyle}
          role="listbox"
        >
          <div className="genre-filter-popover__list">
            {options.map(opt => {
              const isSel = opt.value === value;
              return (
                <div
                  key={opt.value}
                  className={`genre-filter-popover__option${isSel ? ' genre-filter-popover__option--selected' : ''}`}
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  role="option"
                  aria-selected={isSel}
                >
                  <span className="genre-filter-popover__check">
                    {isSel && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {opt.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
