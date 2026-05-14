import { clampStoredLoudnessPreAnalysisAttenuationRefDb } from '../utils/audio/loudnessPreAnalysisSlider';
import {
  DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB,
  LOUDNESS_LUFS_PRESETS,
  MIX_MIN_RATING_FILTER_MAX_STARS,
  RANDOM_MIX_SIZE_OPTIONS,
} from './authStoreDefaults';
import type { LoudnessLufsPreset } from './authStoreTypes';

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function sanitizeLoudnessLufsPreset(v: unknown, fallback: LoudnessLufsPreset): LoudnessLufsPreset {
  return (LOUDNESS_LUFS_PRESETS as readonly number[]).includes(v as number)
    ? (v as LoudnessLufsPreset)
    : fallback;
}

export function sanitizeLoudnessPreAnalysisFromStorage(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB;
  return clampStoredLoudnessPreAnalysisAttenuationRefDb(n);
}

export function clampMixFilterMinStars(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MIX_MIN_RATING_FILTER_MAX_STARS, Math.round(n)));
}

export function clampRandomMixSize(v: number): number {
  if (!Number.isFinite(v)) return 50;
  // Snap to the nearest allowed option so a tampered persisted value can't break the picker.
  let nearest = RANDOM_MIX_SIZE_OPTIONS[0];
  let bestDelta = Math.abs(v - nearest);
  for (const opt of RANDOM_MIX_SIZE_OPTIONS) {
    const d = Math.abs(v - opt);
    if (d < bestDelta) { nearest = opt; bestDelta = d; }
  }
  return nearest;
}

export function clampSkipStarThreshold(v: number): number {
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(99, Math.round(v)));
}

export function skipStarCountStorageKey(serverId: string | null | undefined, trackId: string): string {
  return `${serverId ?? ''}\u001f${trackId}`;
}

export function sanitizeSkipStarCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) next[k] = Math.min(Math.floor(n), 1_000_000);
  }
  return next;
}
