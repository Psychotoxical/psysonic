import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_IN_APP_BINDINGS, type KeyAction } from '../config/shortcutActions';

/** Physical keys only — ignore for binding capture */
export const MODIFIER_KEY_CODES = [
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
] as const;

// key = action, value = plain e.code ("Space", "KeyN") or chord "ctrl+shift+KeyN", null = unbound
export type Bindings = Record<KeyAction, string | null>;

export const DEFAULT_BINDINGS: Bindings = { ...DEFAULT_IN_APP_BINDINGS };
export type { KeyAction } from '../config/shortcutActions';

function normalizeBindings(
  bindings: Partial<Record<KeyAction, string | null>> | undefined
): Bindings {
  return {
    ...DEFAULT_BINDINGS,
    ...(bindings ?? {}),
  } as Bindings;
}

interface KeybindingsState {
  bindings: Bindings;
  setBinding: (action: KeyAction, binding: string | null) => void;
  resetToDefaults: () => void;
}

/** Build persisted binding from a keydown: single key or modifier+key chord. */
export function buildInAppBinding(e: KeyboardEvent): string | null {
  if ((MODIFIER_KEY_CODES as readonly string[]).includes(e.code)) return null;
  if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return e.code;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('super');
  return [...mods, e.code].join('+');
}

/** True if the event matches a stored binding (legacy plain codes = no modifiers). */
export function matchInAppBinding(e: KeyboardEvent, binding: string | null): boolean {
  if (!binding) return false;
  if (!binding.includes('+')) {
    return (
      e.code === binding &&
      !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    );
  }
  const parts = binding.split('+');
  const code = parts[parts.length - 1];
  if (e.code !== code) return false;
  const mods = new Set(parts.slice(0, -1));
  return (
    e.ctrlKey === mods.has('ctrl') &&
    e.altKey === mods.has('alt') &&
    e.shiftKey === mods.has('shift') &&
    e.metaKey === mods.has('super')
  );
}

export const useKeybindingsStore = create<KeybindingsState>()(
  persist(
    (set) => ({
      bindings: normalizeBindings(undefined),
      setBinding: (action, binding) =>
        set(s => ({ bindings: { ...s.bindings, [action]: binding } })),
      resetToDefaults: () => set({ bindings: normalizeBindings(undefined) }),
    }),
    {
      name: 'psysonic_keybindings',
      onRehydrateStorage: () => state => {
        if (!state) return;
        state.bindings = normalizeBindings(state.bindings);
      },
    }
  )
);

/** Format an e.code value into a human-readable label. */
export function formatKeyCode(code: string): string {
  if (code === 'Space') return 'Space';
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  if (code === 'Escape') return 'Esc';
  if (code === 'Enter') return 'Enter';
  if (code === 'Backspace') return '⌫';
  if (code === 'Tab') return 'Tab';
  if (code === 'Delete') return 'Del';
  if (code === 'Home') return 'Home';
  if (code === 'End') return 'End';
  if (code === 'PageUp') return 'PgUp';
  if (code === 'PageDown') return 'PgDn';
  if (/^F\d+$/.test(code)) return code;
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Backslash') return '\\';
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  return code;
}

/** Label for settings UI: plain key or chord (same string shape as global shortcuts). */
export function formatBinding(binding: string): string {
  if (!binding.includes('+')) return formatKeyCode(binding);
  return binding.split('+').map(part => {
    if (part === 'ctrl') return 'Ctrl';
    if (part === 'alt') return 'Alt';
    if (part === 'shift') return 'Shift';
    if (part === 'super' || part === 'meta') return 'Super';
    return formatKeyCode(part);
  }).join('+');
}
