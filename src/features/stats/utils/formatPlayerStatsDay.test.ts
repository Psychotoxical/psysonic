import { describe, expect, it } from 'vitest';
import { formatPlayerStatsDayLabel } from '@/features/stats/utils/formatPlayerStatsDay';

const t = (key: string) => {
  if (key === 'statistics.playerDayToday') return 'Today';
  if (key === 'statistics.playerDayYesterday') return 'Yesterday';
  return key;
};

describe('formatPlayerStatsDayLabel', () => {
  it('labels today and yesterday', () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    expect(formatPlayerStatsDayLabel(`${y}-${m}-${d}`, t, 'en')).toBe('Today');

    const yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    const ym = String(yest.getMonth() + 1).padStart(2, '0');
    const yd = String(yest.getDate()).padStart(2, '0');
    expect(formatPlayerStatsDayLabel(`${yest.getFullYear()}-${ym}-${yd}`, t, 'en')).toBe('Yesterday');
  });
});
