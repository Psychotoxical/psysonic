import { describe, expect, it } from 'vitest';
import { computeFloatingPlayerBarStyle } from '@/features/playback/hooks/computeFloatingPlayerBarStyle';

describe('computeFloatingPlayerBarStyle', () => {
  it('centers in the main column and shrink-wraps instead of stretching', () => {
    const style = computeFloatingPlayerBarStyle(220, 1600, 1920);
    expect(style.left).toBe(910);
    expect(style.right).toBe('auto');
    expect(style.transform).toBe('translateX(-50%)');
    expect(style.width).toBe('max-content');
    expect(style.maxWidth).toBe(1332);
  });

  it('accounts for a hidden queue panel', () => {
    const style = computeFloatingPlayerBarStyle(220, null, 1920);
    expect(style.left).toBe(1070);
    expect(style.maxWidth).toBe(1652);
  });
});
