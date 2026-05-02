import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { MODIFIER_KEY_CODES, formatBinding } from './keybindingsStore';
import { DEFAULT_GLOBAL_SHORTCUTS, isGlobalShortcutActionId, type GlobalAction } from '../config/shortcutActions';

/** Build a Tauri-compatible shortcut string from a KeyboardEvent, or null if invalid. */
export function buildGlobalShortcut(e: KeyboardEvent): string | null {
  if ((MODIFIER_KEY_CODES as readonly string[]).includes(e.code)) return null;
  // Require at least Ctrl, Alt, or Meta — Shift alone is too invasive
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;

  const mods: string[] = [];
  if (e.ctrlKey)  mods.push('ctrl');
  if (e.altKey)   mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey)  mods.push('super');

  return [...mods, e.code].join('+');
}

/** Human-readable label for a stored shortcut string, e.g. "ctrl+alt+ArrowRight" → "Ctrl+Alt+→". */
export function formatGlobalShortcut(shortcut: string): string {
  return formatBinding(shortcut);
}

// Module-level guard — prevents double-registration from React StrictMode's
// intentional double-invocation of effects in development.
let _registerAllCalled = false;

interface GlobalShortcutsState {
  shortcuts: Partial<Record<GlobalAction, string>>;
  setShortcut: (action: GlobalAction, shortcut: string | null) => Promise<void>;
  registerAll: () => Promise<void>;
  resetAll: () => Promise<void>;
}

export const useGlobalShortcutsStore = create<GlobalShortcutsState>()(
  persist(
    (set, get) => ({
      shortcuts: { ...DEFAULT_GLOBAL_SHORTCUTS },

      setShortcut: async (action, shortcut) => {
        const prev = get().shortcuts[action];
        if (prev) {
          try { await invoke('unregister_global_shortcut', { shortcut: prev }); } catch {}
        }
        if (shortcut) {
          try {
            await invoke('register_global_shortcut', { shortcut, action });
            set(s => ({ shortcuts: { ...s.shortcuts, [action]: shortcut } }));
          } catch (e) {
            console.warn('[GlobalShortcuts] Failed to register:', shortcut, e);
          }
        } else {
          set(s => {
            const next = { ...s.shortcuts };
            delete next[action];
            return { shortcuts: next };
          });
        }
      },

      registerAll: async () => {
        if (_registerAllCalled) return;
        _registerAllCalled = true;
        const { shortcuts } = get();
        for (const [action, shortcut] of Object.entries(shortcuts)) {
          if (!isGlobalShortcutActionId(action)) continue;
          if (shortcut) {
            try {
              await invoke('register_global_shortcut', { shortcut, action });
            } catch (e) {
              console.warn('[GlobalShortcuts] Failed to re-register:', shortcut, e);
            }
          }
        }
      },

      resetAll: async () => {
        const { shortcuts } = get();
        for (const shortcut of Object.values(shortcuts)) {
          if (shortcut) {
            try { await invoke('unregister_global_shortcut', { shortcut }); } catch {}
          }
        }
        set({ shortcuts: { ...DEFAULT_GLOBAL_SHORTCUTS } });
      },
    }),
    { name: 'psysonic_global_shortcuts' }
  )
);

export type { GlobalAction } from '../config/shortcutActions';
