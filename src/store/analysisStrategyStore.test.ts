import { describe, it, expect, beforeEach } from 'vitest';
import { useAnalysisStrategyStore } from './analysisStrategyStore';
import {
  DEFAULT_ADVANCED_PARALLELISM,
  DEFAULT_ANALYTICS_STRATEGY,
} from '@/lib/library/analysisStrategy';

describe('analysisStrategyStore', () => {
  beforeEach(() => {
    useAnalysisStrategyStore.setState({
      strategy: DEFAULT_ANALYTICS_STRATEGY,
      advancedParallelism: DEFAULT_ADVANCED_PARALLELISM,
      strategyByServer: {},
      advancedParallelismByServer: {},
    });
  });

  it('defaults to lazy', () => {
    expect(useAnalysisStrategyStore.getState().strategy).toBe('lazy');
  });

  it('defaults advanced parallelism to 1', () => {
    expect(useAnalysisStrategyStore.getState().advancedParallelism).toBe(1);
  });

  it('persists strategy changes in memory', () => {
    useAnalysisStrategyStore.getState().setStrategy('advanced');
    expect(useAnalysisStrategyStore.getState().strategy).toBe('advanced');
  });

  it('clamps advanced parallelism to 1–20', () => {
    useAnalysisStrategyStore.getState().setAdvancedParallelism(99);
    expect(useAnalysisStrategyStore.getState().advancedParallelism).toBe(20);
    useAnalysisStrategyStore.getState().setAdvancedParallelism(0);
    expect(useAnalysisStrategyStore.getState().advancedParallelism).toBe(1);
  });

  it('tracks per-server strategy overrides', () => {
    const store = useAnalysisStrategyStore.getState();
    store.setServerStrategy('s1', 'advanced');
    expect(store.getStrategyForServer('s1')).toBe('advanced');
    expect(store.getStrategyForServer('s2')).toBe(DEFAULT_ANALYTICS_STRATEGY);
  });

  it('tracks per-server parallelism overrides', () => {
    const store = useAnalysisStrategyStore.getState();
    store.setServerAdvancedParallelism('s1', 8);
    expect(store.getAdvancedParallelismForServer('s1')).toBe(8);
    expect(store.getAdvancedParallelismForServer('s2')).toBe(DEFAULT_ADVANCED_PARALLELISM);
  });

  it('clears per-server overrides', () => {
    const store = useAnalysisStrategyStore.getState();
    store.setServerStrategy('s1', 'advanced');
    store.setServerAdvancedParallelism('s1', 6);
    store.clearServerOverrides('s1');
    expect(store.getStrategyForServer('s1')).toBe(DEFAULT_ANALYTICS_STRATEGY);
    expect(store.getAdvancedParallelismForServer('s1')).toBe(DEFAULT_ADVANCED_PARALLELISM);
  });
});
