import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { audioSetEq } from '@/lib/api/audio';

export const EQ_BANDS = [
  { freq: 31,    label: '31' },
  { freq: 62,    label: '62' },
  { freq: 125,   label: '125' },
  { freq: 250,   label: '250' },
  { freq: 500,   label: '500' },
  { freq: 1000,  label: '1k' },
  { freq: 2000,  label: '2k' },
  { freq: 4000,  label: '4k' },
  { freq: 8000,  label: '8k' },
  { freq: 16000, label: '16k' },
];

export interface EqPreset {
  name: string;
  gains: number[];
  builtin: boolean;
}

/** The per-device-storable slice of the EQ (everything except the global preset list). */
export interface EqSnapshot {
  gains: number[];
  enabled: boolean;
  preGain: number;
  activePreset: string | null;
}

export const BUILTIN_PRESETS: EqPreset[] = [
  { name: 'Flat',        builtin: true, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Bass Boost',  builtin: true, gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: 'Treble Boost',builtin: true, gains: [0, 0, 0, 0, 0, 0, 2, 3, 4, 5] },
  { name: 'Rock',        builtin: true, gains: [4, 3, 1, 0, -1, -1, 1, 3, 4, 4] },
  { name: 'Pop',         builtin: true, gains: [-2, -1, 0, 2, 4, 4, 2, 0, -1, -2] },
  { name: 'Jazz',        builtin: true, gains: [4, 3, 1, 2, -1, -1, 0, 1, 2, 3] },
  { name: 'Classical',   builtin: true, gains: [5, 4, 3, 2, -2, -2, 0, 2, 3, 4] },
  { name: 'Electronic',  builtin: true, gains: [5, 4, 1, 0, -2, 1, 1, 2, 4, 5] },
  { name: 'Vocal',       builtin: true, gains: [-2, -2, 0, 3, 5, 5, 3, 1, -1, -2] },
  { name: 'Acoustic',    builtin: true, gains: [3, 2, 2, 2, 0, 0, 1, 2, 2, 3] },
];

interface EqState {
  gains: number[];           // 10 values, -12 to +12 dB
  enabled: boolean;
  preGain: number;           // pre-amplification in dB (-30 to +6), applied before bands
  activePreset: string | null;
  customPresets: EqPreset[];

  /** Opt-in: remember the EQ profile per audio output device (default off). */
  rememberPerDevice: boolean;
  /** Saved EQ snapshot per device key (canonical device name; '__default__' = system default). */
  byDevice: Record<string, EqSnapshot>;

  setBandGain: (index: number, gain: number) => void;
  setEnabled: (v: boolean) => void;
  setPreGain: (v: number) => void;
  applyPreset: (name: string) => void;
  applyAutoEq: (name: string, gains: number[], preGain: number) => void;
  saveCustomPreset: (name: string) => void;
  deleteCustomPreset: (name: string) => void;
  syncToRust: () => void;

  setRememberPerDevice: (v: boolean) => void;
  /** Apply a saved snapshot to the live EQ (clamped) and push it to Rust. */
  applySnapshot: (snap: EqSnapshot) => void;
  /** Capture the current live EQ into `byDevice[deviceKey]`. */
  saveSnapshotFor: (deviceKey: string) => void;
}

function syncEq(gains: number[], enabled: boolean, preGain: number) {
  audioSetEq({ gains: gains.map(g => g), enabled, preGain }).catch(() => {});
}

export const useEqStore = create<EqState>()(
  persist(
    (set, get) => ({
      gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      enabled: false,
      preGain: 0,
      activePreset: 'Flat',
      customPresets: [],
      rememberPerDevice: false,
      byDevice: {},

      setBandGain: (index, gain) => {
        const clamped = Math.max(-12, Math.min(12, gain));
        const gains = [...get().gains];
        gains[index] = clamped;
        set({ gains, activePreset: null });
        syncEq(gains, get().enabled, get().preGain);
      },

      setEnabled: (v) => {
        set({ enabled: v });
        syncEq(get().gains, v, get().preGain);
      },

      setPreGain: (v) => {
        const clamped = Math.max(-30, Math.min(6, v));
        set({ preGain: clamped, activePreset: null });
        syncEq(get().gains, get().enabled, clamped);
      },

      applyAutoEq: (name, gains, preGain) => {
        const clampedPreGain = Math.max(-30, Math.min(6, preGain));
        const clampedGains = gains.map(g => Math.max(-12, Math.min(12, g)));
        set({ gains: clampedGains, preGain: clampedPreGain, activePreset: name });
        syncEq(clampedGains, get().enabled, clampedPreGain);
      },

      applyPreset: (name) => {
        const all = [...BUILTIN_PRESETS, ...get().customPresets];
        const preset = all.find(p => p.name === name);
        if (!preset) return;
        set({ gains: [...preset.gains], activePreset: name });
        syncEq(preset.gains, get().enabled, get().preGain);
      },

      saveCustomPreset: (name) => {
        const gains = [...get().gains];
        const existing = get().customPresets.filter(p => p.name !== name);
        set({ customPresets: [...existing, { name, gains, builtin: false }], activePreset: name });
      },

      deleteCustomPreset: (name) => {
        set(s => ({
          customPresets: s.customPresets.filter(p => p.name !== name),
          activePreset: s.activePreset === name ? null : s.activePreset,
        }));
      },

      syncToRust: () => {
        const { gains, enabled, preGain } = get();
        syncEq(gains, enabled, preGain);
      },

      setRememberPerDevice: (v) => set({ rememberPerDevice: v }),

      applySnapshot: (snap) => {
        const gains = snap.gains.map(g => Math.max(-12, Math.min(12, g)));
        const preGain = Math.max(-30, Math.min(6, snap.preGain));
        set({ gains, enabled: snap.enabled, preGain, activePreset: snap.activePreset });
        syncEq(gains, snap.enabled, preGain);
      },

      saveSnapshotFor: (deviceKey) => {
        const { gains, enabled, preGain, activePreset } = get();
        set(s => ({
          byDevice: { ...s.byDevice, [deviceKey]: { gains: [...gains], enabled, preGain, activePreset } },
        }));
      },
    }),
    {
      name: 'psysonic-eq',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        gains: s.gains,
        enabled: s.enabled,
        preGain: s.preGain,
        activePreset: s.activePreset,
        customPresets: s.customPresets,
        rememberPerDevice: s.rememberPerDevice,
        byDevice: s.byDevice,
      }),
    }
  )
);
