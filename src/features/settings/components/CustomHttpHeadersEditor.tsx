import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomHeaderEntry, CustomHeadersApplyTo } from '@/store/authStoreTypes';

export type CustomHttpHeadersEditorProps = {
  headers: CustomHeaderEntry[];
  applyTo: CustomHeadersApplyTo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onHeadersChange: (headers: CustomHeaderEntry[]) => void;
  onApplyToChange: (applyTo: CustomHeadersApplyTo) => void;
  /** Optional id prefix for radio group name (avoid collisions when multiple forms mount). */
  radioGroupName?: string;
};

export function CustomHttpHeadersEditor({
  headers,
  applyTo,
  open,
  onOpenChange,
  onHeadersChange,
  onApplyToChange,
  radioGroupName = 'customHeadersApplyTo',
}: CustomHttpHeadersEditorProps) {
  const { t } = useTranslation();

  return (
    <div className="form-group" style={{ marginBottom: '0.75rem' }}>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ fontSize: 13, padding: '4px 0' }}
        onClick={() => onOpenChange(!open)}
      >
        {open ? '▾' : '▸'} {t('settings.customHeadersTitle')}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 11, opacity: 0.75, margin: '0 0 8px' }}>
            {t('settings.customHeadersHelp')}
          </p>
          {headers.map((row, index) => (
            <div key={index} className="form-row" style={{ marginBottom: 6, gap: 8 }}>
              <input
                className="input"
                type="text"
                value={row.name}
                onChange={e => {
                  const name = e.target.value;
                  onHeadersChange(headers.map((h, i) => (i === index ? { ...h, name } : h)));
                }}
                placeholder={t('settings.customHeadersNamePlaceholder')}
                autoComplete="off"
              />
              <input
                className="input"
                type="password"
                value={row.value}
                onChange={e => {
                  const value = e.target.value;
                  onHeadersChange(headers.map((h, i) => (i === index ? { ...h, value } : h)));
                }}
                placeholder={t('settings.customHeadersValuePlaceholder')}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={t('settings.customHeadersRemoveRow')}
                onClick={() =>
                  onHeadersChange(
                    headers.length <= 1
                      ? [{ name: '', value: '' }]
                      : headers.filter((_, i) => i !== index),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, marginBottom: 8 }}
            onClick={() => onHeadersChange([...headers, { name: '', value: '' }])}
          >
            {t('settings.customHeadersAddRow')}
          </button>
          <fieldset
            disabled={!headers.some(h => h.name.trim() || h.value)}
            style={{ border: 'none', padding: 0, margin: 0 }}
          >
            <legend style={{ fontSize: 12, marginBottom: 4 }}>{t('settings.customHeadersApplyTo')}</legend>
            {(['public', 'local', 'both'] as const).map(kind => (
              <label key={kind} style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                <input
                  type="radio"
                  name={radioGroupName}
                  checked={applyTo === kind}
                  onChange={() => onApplyToChange(kind)}
                />{' '}
                {t(`settings.customHeadersApplyTo_${kind}`)}
              </label>
            ))}
          </fieldset>
          <p style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>
            {t('settings.customHeadersNotInShare')}
          </p>
        </div>
      )}
    </div>
  );
}
