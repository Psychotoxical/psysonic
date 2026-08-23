import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tags } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import type { SmartPlaylistCustomFieldSetting } from '@/store/authStoreTypes';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';
import { createCustomSmartRuleField } from '@/features/playlist';

const FIELD_TYPES: Array<{
  value: SmartPlaylistCustomFieldSetting['type'];
  labelKey: 'typeString' | 'typeNumber' | 'typeBoolean' | 'typeDate';
}> = [
  { value: 'string', labelKey: 'typeString' },
  { value: 'number', labelKey: 'typeNumber' },
  { value: 'boolean', labelKey: 'typeBoolean' },
  { value: 'date', labelKey: 'typeDate' },
];

export function SmartPlaylistCustomFieldsSection({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const { t } = useTranslation();
  const fields = useAuthStore(state => state.smartPlaylistCustomFields);
  const setFields = useAuthStore(state => state.setSmartPlaylistCustomFields);
  const [name, setName] = useState('');
  const [type, setType] = useState<SmartPlaylistCustomFieldSetting['type']>('string');
  const [kind, setKind] = useState<SmartPlaylistCustomFieldSetting['kind']>('tag');
  const [error, setError] = useState<string | null>(null);

  const addField = () => {
    const next: SmartPlaylistCustomFieldSetting = { name: name.trim(), type, kind };
    try {
      createCustomSmartRuleField(next);
    } catch {
      setError(t('settings.smartPlaylistCustomFieldsInvalid'));
      return;
    }
    if (fields.some(field => field.name.toLowerCase() === next.name.toLowerCase())) {
      setError(t('settings.smartPlaylistCustomFieldsDuplicate'));
      return;
    }
    setFields([...fields, next]);
    setName('');
    setError(null);
  };

  return (
    <SettingsSubSection
      title={t('settings.smartPlaylistCustomFieldsTitle')}
      icon={<Tags size={16} />}
      defaultOpen={defaultOpen}
    >
      <div className="settings-card">
        <SettingsGroup>
          <SettingsSubCard>
            <SettingsField desc={t('settings.smartPlaylistCustomFieldsDesc')} />
            <SettingsField label={t('settings.smartPlaylistCustomFieldsList')}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', minHeight: 32 }}>
                {fields.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
                    {t('settings.smartPlaylistCustomFieldsEmpty')}
                  </span>
                ) : (
                  fields.map(field => (
                    <span
                      key={field.name}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                        color: 'var(--accent)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '2px 8px',
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                    >
                      {field.name}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                        {field.kind === 'tag' ? t('smartPlaylists.customFieldTag') : t('smartPlaylists.customFieldRole')}
                      </span>
                      <button
                        type="button"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: 14 }}
                        onClick={() => setFields(fields.filter(item => item.name !== field.name))}
                        aria-label={t('settings.smartPlaylistCustomFieldsRemove', { name: field.name })}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', maxWidth: 640 }}>
                <input
                  className="input"
                  type="text"
                  value={name}
                  onChange={event => {
                    setName(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && name.trim()) addField();
                  }}
                  placeholder={t('smartPlaylists.customFieldName')}
                  style={{ fontSize: 13, minWidth: 140 }}
                />
                <select className="input" value={type} onChange={event => setType(event.target.value as typeof type)} style={{ fontSize: 13 }}>
                  {FIELD_TYPES.map(option => (
                    <option key={option.value} value={option.value}>{t(`smartPlaylists.${option.labelKey}`)}</option>
                  ))}
                </select>
                <select className="input" value={kind} onChange={event => setKind(event.target.value as typeof kind)} style={{ fontSize: 13 }}>
                  <option value="tag">{t('smartPlaylists.customFieldTag')}</option>
                  <option value="role">{t('smartPlaylists.customFieldRole')}</option>
                </select>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={addField}
                  disabled={!name.trim()}
                >
                  {t('smartPlaylists.customFieldAdd')}
                </button>
              </div>
              {error && (
                <div style={{ fontSize: 12, color: 'var(--danger, #c0392b)' }}>{error}</div>
              )}
            </SettingsField>
          </SettingsSubCard>
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
