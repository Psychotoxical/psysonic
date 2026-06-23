import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, RotateCcw } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { ColDef } from '../../utils/useTracklistColumns';

interface Props {
  /** Every column (required ones are filtered out of the menu). */
  allColumns: readonly ColDef[];
  pickerRef: React.RefObject<HTMLDivElement | null>;
  pickerOpen: boolean;
  setPickerOpen: (updater: (v: boolean) => boolean) => void;
  colVisible: Set<string>;
  toggleColumn: (key: string) => void;
  resetColumns: () => void;
  t: TFunction;
}

/**
 * The column-visibility dropdown for tracklists. The menu is rendered in a
 * portal with fixed positioning anchored to the trigger button, so it can never
 * be clipped by an ancestor's overflow box — the reason short lists (e.g. a
 * one-song Favorites list) used to cut it off. Shared by every tracklist
 * (albums, playlists, favorites); all popover behaviour lives here, so the
 * pages only wire up column state.
 */
export function TracklistColumnPicker({
  allColumns,
  pickerRef,
  pickerOpen,
  setPickerOpen,
  colVisible,
  toggleColumn,
  resetColumns,
  t,
}: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Start off-screen until measured so the portal never flashes at 0,0.
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({
    position: 'fixed', top: -9999, left: -9999,
  });

  const updatePos = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const MARGIN = 8;
    const r = btn.getBoundingClientRect();
    const menuH = popRef.current?.offsetHeight ?? 240;
    const spaceBelow = window.innerHeight - r.bottom;
    // Flip above the trigger when there isn't room below and there is above.
    const openUp = spaceBelow < menuH + MARGIN && r.top > spaceBelow;
    setMenuStyle({
      position: 'fixed',
      right: Math.max(MARGIN, window.innerWidth - r.right),
      zIndex: 10050,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + 4 }
        : { top: r.bottom + 4 }),
    });
  };

  // Position before paint so the menu appears in place.
  useLayoutEffect(() => {
    if (pickerOpen) updatePos();
  }, [pickerOpen]);

  // Keep anchored on scroll/resize, and close on outside-click / Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const reposition = () => updatePos();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setPickerOpen(() => false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(() => false);
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);

  return (
    <div className="tracklist-col-picker-wrapper" ref={pickerRef}>
      <div className="tracklist-col-picker">
        <button
          ref={btnRef}
          className="tracklist-col-picker-btn"
          onClick={e => { e.stopPropagation(); setPickerOpen(v => !v); }}
          data-tooltip={t('albumDetail.columns')}
        >
          <ChevronDown size={14} />
        </button>
        {pickerOpen && createPortal(
          <div className="tracklist-col-picker-menu" ref={popRef} style={menuStyle}>
            <div className="tracklist-col-picker-label">{t('albumDetail.columns')}</div>
            {allColumns.filter(c => !c.required).map(c => {
              const label = c.i18nKey ? t(`albumDetail.${c.i18nKey as string}`) : c.key;
              const isOn = colVisible.has(c.key);
              return (
                <button
                  key={c.key}
                  className={`tracklist-col-picker-item${isOn ? ' active' : ''}`}
                  onClick={() => toggleColumn(c.key)}
                >
                  <span className="tracklist-col-picker-check">
                    {isOn && <Check size={13} />}
                  </span>
                  {label}
                </button>
              );
            })}
            <div className="tracklist-col-picker-divider" />
            <button className="tracklist-col-picker-reset" onClick={resetColumns}>
              <RotateCcw size={13} />
              {t('albumDetail.resetColumns')}
            </button>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}
