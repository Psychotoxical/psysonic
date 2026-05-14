import React from 'react';
import { Check, ChevronDown, RotateCcw } from 'lucide-react';
import type { TFunction } from 'i18next';
import { COLUMNS } from '../../utils/componentHelpers/albumTrackListHelpers';

interface Props {
  pickerRef: React.RefObject<HTMLDivElement | null>;
  pickerOpen: boolean;
  setPickerOpen: (updater: (v: boolean) => boolean) => void;
  colVisible: Set<string>;
  toggleColumn: (key: string) => void;
  resetColumns: () => void;
  t: TFunction;
}

/**
 * The column visibility dropdown that sits outside `.tracklist` so the
 * popover menu can grow without being clipped by the tracklist's overflow
 * box. Lists every non-required column and offers a reset-to-defaults
 * button.
 */
export function TracklistColumnPicker({
  pickerRef,
  pickerOpen,
  setPickerOpen,
  colVisible,
  toggleColumn,
  resetColumns,
  t,
}: Props) {
  return (
    <div className="tracklist-col-picker-wrapper" ref={pickerRef}>
      <div className="tracklist-col-picker">
        <button
          className="tracklist-col-picker-btn"
          onClick={e => { e.stopPropagation(); setPickerOpen(v => !v); }}
          data-tooltip={t('albumDetail.columns')}
        >
          <ChevronDown size={14} />
        </button>
        {pickerOpen && (
          <div className="tracklist-col-picker-menu">
            <div className="tracklist-col-picker-label">{t('albumDetail.columns')}</div>
            {COLUMNS.filter(c => !c.required).map(c => {
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
          </div>
        )}
      </div>
    </div>
  );
}
