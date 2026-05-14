import { useEffect } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useKeybindingsStore, buildInAppBinding } from '../../store/keybindingsStore';
import { useGlobalShortcutsStore } from '../../store/globalShortcutsStore';
import { DEFAULT_IN_APP_BINDINGS, executeRuntimeAction } from '../../config/shortcutActions';
import { matchInAppShortcutAction } from '../../shortcuts/runtime';

/** Configurable in-app keybindings: matches keydown chords against the user's
 * bindings, skipping chords claimed by a registered global shortcut. */
export function useInAppKeybindings(navigate: NavigateFunction) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      const editable = Boolean(el?.isContentEditable);
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) return;

      const chord = buildInAppBinding(e);
      if (chord) {
        const registered = Object.values(useGlobalShortcutsStore.getState().shortcuts);
        if (registered.includes(chord)) return;
      }

      const { bindings } = useKeybindingsStore.getState();
      const action = matchInAppShortcutAction(e, { ...DEFAULT_IN_APP_BINDINGS, ...bindings });

      if (!action) return;
      e.preventDefault();
      executeRuntimeAction(action, { navigate, previewPolicy: 'stop' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
