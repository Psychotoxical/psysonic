import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type KeyAction =
  | 'play-pause'
  | 'next'
  | 'prev'
  | 'volume-up'
  | 'volume-down'
  | 'seek-forward'
  | 'seek-backward'
  | 'toggle-queue'
  | 'fullscreen-player'
  | 'native-fullscreen';

// key = action, value = e.code string (e.g. 'Space', 'KeyN', 'F11') or null for unbound
export type Bindings = Record<KeyAction, string | null>;

export const DEFAULT_BINDINGS: Bindings = {
  'play-pause':        'Space',
  'next':              null,
  'prev':              null,
  'volume-up':         null,
  'volume-down':       null,
  'seek-forward':      null,
  'seek-backward':     null,
  'toggle-queue':      null,
  'fullscreen-player': null,
  'native-fullscreen': 'F11',
};

interface KeybindingsState {
  bindings: Bindings;
  setBinding: (action: KeyAction, code: string | null) => void;
  resetToDefaults: () => void;
}

export const useKeybindingsStore = create<KeybindingsState>()(
  persist(
    (set) => ({
      bindings: { ...DEFAULT_BINDINGS },
      setBinding: (action, code) =>
        set(s => ({ bindings: { ...s.bindings, [action]: code } })),
      resetToDefaults: () => set({ bindings: { ...DEFAULT_BINDINGS } }),
    }),
    { name: 'psysonic_keybindings' }
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
