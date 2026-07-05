// ─── AutoEQ helpers ───────────────────────────────────────────────────────────

export interface AutoEqVariant { form: string; rig: string | null; source: string; }
export interface AutoEqResult  { name: string; source: string; rig: string | null; form: string; }

/** Parses AutoEQ FixedBandEQ.txt format.
 * Expected lines:
 *   Preamp: -5.5 dB
 *   Filter 1: ON PK Fc 31 Hz Gain -0.2 dB Q 1.41
 *   ...
 * Returns all 10 band gains as exact floats and the preamp value.
 */
export function parseFixedBandEqString(text: string): { gains: number[]; preamp: number } {
  const preampMatch = text.match(/Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const preamp = preampMatch ? parseFloat(preampMatch[1]) : 0;

  const gains: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const allFilters = [...text.matchAll(/^Filter\s+\d+:\s+ON\s+PK\s+.*?Gain\s+(-?\d+(?:\.\d+)?)\s+dB/gim)];
  allFilters.slice(0, 10).forEach((m, i) => {
    gains[i] = parseFloat(m[1]);
  });

  return { gains, preamp };
}
