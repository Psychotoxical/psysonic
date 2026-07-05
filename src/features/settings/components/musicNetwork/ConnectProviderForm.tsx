import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  errorI18nKey,
  isMusicNetworkError,
  listPresets,
  type BuiltinPreset,
  type PresetId,
} from '@/music-network';
import { renderPresetIcon } from '@/music-network';

/**
 * "Add a service" list, driven entirely by the preset registry. Token-poll
 * presets connect immediately (browser flow); paste presets expand an inline
 * form built from the manifest's `fields`. Adding a provider needs no edit here.
 */
export function ConnectProviderForm({
  connectedPresetIds,
  onConnect,
}: {
  connectedPresetIds: PresetId[];
  onConnect: (presetId: PresetId, fields: Record<string, string>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<PresetId | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<PresetId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bundled single-instance presets disappear once connected; self-hosted /
  // custom presets can be added repeatedly.
  const available = listPresets().filter(
    p => !(p.manifest.credentials === 'bundled' && connectedPresetIds.includes(p.manifest.presetId)),
  );

  const toMessage = (e: unknown): string =>
    isMusicNetworkError(e) ? t(errorI18nKey(e.code)) : t('musicNetwork.connectFailed');

  const run = async (presetId: PresetId, payload: Record<string, string>) => {
    // Enforce the manifest's `required` fields client-side so an empty URL/token
    // gives a clear message instead of falling through to a confusing NETWORK error.
    const preset = available.find(p => p.manifest.presetId === presetId);
    const missing = preset?.manifest.fields.find(f => f.required && !(payload[f.name] ?? '').trim());
    if (missing) {
      setError(t('musicNetwork.fieldRequired', { field: t(missing.labelKey) }));
      return;
    }
    setBusy(presetId);
    setError(null);
    try {
      await onConnect(presetId, payload);
      setExpanded(null);
      setFields({});
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const onPrimaryAction = (preset: BuiltinPreset) => {
    const id = preset.manifest.presetId;
    if (preset.manifest.fields.length === 0) {
      void run(id, {});
    } else {
      setError(null);
      setFields({});
      setExpanded(expanded === id ? null : id);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div className="settings-group-title">{t('musicNetwork.addService')}</div>
      {available.map(preset => {
        const id = preset.manifest.presetId;
        const isExpanded = expanded === id;
        const isBusy = busy === id;
        return (
          <div key={id} className="settings-group" style={{ padding: '0.75rem 1rem', marginTop: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ flexShrink: 0 }} aria-hidden="true">{renderPresetIcon(preset.manifest.icon, 18)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{preset.manifest.displayName}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t(preset.manifest.descriptionKey)}</div>
              </div>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }}
                disabled={isBusy}
                onClick={() => onPrimaryAction(preset)}
              >
                {isBusy ? t('musicNetwork.connecting') : t('musicNetwork.connect')}
              </button>
            </div>

            {isExpanded && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
                {preset.manifest.fields.map(field => (
                  <div className="form-group" key={field.name}>
                    <label style={{ fontSize: 12 }}>{t(field.labelKey)}</label>
                    <input
                      className="input"
                      type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
                      placeholder={field.placeholder}
                      value={fields[field.name] ?? ''}
                      onChange={e => setFields(f => ({ ...f, [field.name]: e.target.value }))}
                    />
                    {field.helpKey && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, whiteSpace: 'pre-line', lineHeight: 1.5 }}>
                        {t(field.helpKey)}
                      </div>
                    )}
                  </div>
                ))}
                <button
                  className="btn btn-primary"
                  style={{ alignSelf: 'flex-start', fontSize: 12 }}
                  disabled={isBusy}
                  onClick={() => void run(id, fields)}
                >
                  {isBusy ? t('musicNetwork.connecting') : t('musicNetwork.connect')}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {error && <p style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}
