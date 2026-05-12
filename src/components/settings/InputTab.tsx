import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, RotateCcw, X } from 'lucide-react';
import { IN_APP_SHORTCUT_ACTIONS, GLOBAL_SHORTCUT_ACTIONS } from '../../config/shortcutActions';
import { useGlobalShortcutsStore, type GlobalAction, buildGlobalShortcut, formatGlobalShortcut } from '../../store/globalShortcutsStore';
import { useKeybindingsStore, type KeyAction, buildInAppBinding, formatBinding } from '../../store/keybindingsStore';
import SettingsSubSection from '../SettingsSubSection';

export function InputTab() {
  const { t } = useTranslation();
  const kb = useKeybindingsStore();
  const gs = useGlobalShortcutsStore();
  const [listeningFor, setListeningFor] = useState<KeyAction | null>(null);
  const [listeningForGlobal, setListeningForGlobal] = useState<GlobalAction | null>(null);

  return (
    <>
      <SettingsSubSection
        title={t('settings.inputKeybindingsTitle')}
        icon={<Keyboard size={16} />}
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => { kb.resetToDefaults(); setListeningFor(null); }}
            data-tooltip={t('settings.shortcutsReset')}
            aria-label={t('settings.shortcutsReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <div className="settings-card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {IN_APP_SHORTCUT_ACTIONS.map(({ id: action, getLabel }) => {
              const label = getLabel(t);
              const bound = kb.bindings[action];
              const isListening = listeningFor === action;
              return (
                <div key={action} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                  background: isListening ? 'var(--accent-dim)' : 'transparent',
                  transition: 'background 0.15s',
                }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      onClick={() => {
                        if (isListening) { setListeningFor(null); return; }
                        setListeningFor(action);
                        const handler = (e: KeyboardEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.code === 'Escape') {
                            setListeningFor(null);
                            window.removeEventListener('keydown', handler, true);
                            return;
                          }
                          const chord = buildInAppBinding(e);
                          if (!chord) return;
                          const existing = (Object.entries(kb.bindings) as [KeyAction, string | null][])
                            .find(([, c]) => c === chord)?.[0];
                          if (existing && existing !== action) kb.setBinding(existing, null);
                          kb.setBinding(action, chord);
                          setListeningFor(null);
                          window.removeEventListener('keydown', handler, true);
                        };
                        window.addEventListener('keydown', handler, true);
                      }}
                      className="keybind-badge"
                      style={{
                        minWidth: 72, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
                        fontSize: 12, fontWeight: 600, fontFamily: 'monospace',
                        background: isListening ? 'var(--accent)' : bound ? 'var(--bg-hover)' : 'var(--bg-card)',
                        color: isListening ? 'var(--ctp-base)' : bound ? 'var(--text-primary)' : 'var(--text-muted)',
                        border: `1px solid ${isListening ? 'var(--accent)' : 'var(--border-subtle)'}`,
                        cursor: 'pointer',
                      }}
                    >
                      {isListening ? t('settings.shortcutListening') : bound ? formatBinding(bound) : t('settings.shortcutUnbound')}
                    </button>
                    {bound && !isListening && (
                      <button
                        onClick={() => kb.setBinding(action, null)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px 4px', lineHeight: 1 }}
                        data-tooltip={t('settings.shortcutClear')}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.globalShortcutsTitle')}
        icon={<Keyboard size={16} />}
        description={t('settings.globalShortcutsNote')}
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => { gs.resetAll(); setListeningForGlobal(null); }}
            data-tooltip={t('settings.shortcutsReset')}
            aria-label={t('settings.shortcutsReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <div className="settings-card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {GLOBAL_SHORTCUT_ACTIONS.map(({ id: action, getLabel }) => {
              const label = getLabel(t);
              const bound = gs.shortcuts[action] ?? null;
              const isListening = listeningForGlobal === action;
              return (
                <div key={action} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                  background: isListening ? 'var(--accent-dim)' : 'transparent',
                  transition: 'background 0.15s',
                }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      onClick={() => {
                        if (isListening) { setListeningForGlobal(null); return; }
                        setListeningForGlobal(action);
                        const handler = (e: KeyboardEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.code === 'Escape') {
                            setListeningForGlobal(null);
                            window.removeEventListener('keydown', handler, true);
                            return;
                          }
                          const shortcut = buildGlobalShortcut(e);
                          if (shortcut) {
                            gs.setShortcut(action, shortcut);
                            setListeningForGlobal(null);
                            window.removeEventListener('keydown', handler, true);
                          }
                        };
                        window.addEventListener('keydown', handler, true);
                      }}
                      className="keybind-badge"
                      style={{
                        minWidth: 120, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
                        fontSize: 12, fontWeight: 600, fontFamily: 'monospace',
                        background: isListening ? 'var(--accent)' : bound ? 'var(--bg-hover)' : 'var(--bg-card)',
                        color: isListening ? 'var(--ctp-base)' : bound ? 'var(--text-primary)' : 'var(--text-muted)',
                        border: `1px solid ${isListening ? 'var(--accent)' : 'var(--border-subtle)'}`,
                        cursor: 'pointer',
                      }}
                    >
                      {isListening ? t('settings.shortcutListening') : bound ? formatGlobalShortcut(bound) : t('settings.shortcutUnbound')}
                    </button>
                    {bound && !isListening && (
                      <button
                        onClick={() => gs.setShortcut(action, null)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px 4px', lineHeight: 1 }}
                        data-tooltip={t('settings.shortcutClear')}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </SettingsSubSection>
    </>
  );
}
