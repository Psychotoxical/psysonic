import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  clampAdvancedParallelism,
  DEFAULT_ADVANCED_PARALLELISM,
  DEFAULT_ANALYTICS_STRATEGY,
  type AnalyticsStrategy,
} from '../utils/library/analysisStrategy';

interface AnalysisStrategyState {
  strategy: AnalyticsStrategy;
  advancedParallelism: number;
  strategyByServer: Record<string, AnalyticsStrategy | undefined>;
  advancedParallelismByServer: Record<string, number | undefined>;
  setStrategy: (strategy: AnalyticsStrategy) => void;
  setAdvancedParallelism: (workers: number) => void;
  setServerStrategy: (serverId: string, strategy: AnalyticsStrategy) => void;
  setServerAdvancedParallelism: (serverId: string, workers: number) => void;
  clearServerOverrides: (serverId: string) => void;
  getStrategyForServer: (serverId: string | null | undefined) => AnalyticsStrategy;
  getAdvancedParallelismForServer: (serverId: string | null | undefined) => number;
}

export const useAnalysisStrategyStore = create<AnalysisStrategyState>()(
  persist(
    (set, get) => ({
      strategy: DEFAULT_ANALYTICS_STRATEGY,
      advancedParallelism: DEFAULT_ADVANCED_PARALLELISM,
      strategyByServer: {},
      advancedParallelismByServer: {},
      setStrategy: strategy => set({ strategy }),
      setAdvancedParallelism: workers =>
        set({ advancedParallelism: clampAdvancedParallelism(workers) }),
      setServerStrategy: (serverId, strategy) =>
        set(s => ({
          strategyByServer: { ...s.strategyByServer, [serverId]: strategy },
        })),
      setServerAdvancedParallelism: (serverId, workers) =>
        set(s => ({
          advancedParallelismByServer: {
            ...s.advancedParallelismByServer,
            [serverId]: clampAdvancedParallelism(workers),
          },
        })),
      clearServerOverrides: (serverId) =>
        set(s => {
          const { [serverId]: _, ...strategyByServer } = s.strategyByServer;
          const { [serverId]: __, ...advancedParallelismByServer } = s.advancedParallelismByServer;
          return { strategyByServer, advancedParallelismByServer };
        }),
      getStrategyForServer: serverId => {
        if (!serverId) return DEFAULT_ANALYTICS_STRATEGY;
        return get().strategyByServer[serverId] ?? get().strategy;
      },
      getAdvancedParallelismForServer: serverId => {
        if (!serverId) return DEFAULT_ADVANCED_PARALLELISM;
        return get().advancedParallelismByServer[serverId] ?? get().advancedParallelism;
      },
    }),
    {
      name: 'psysonic-analytics-strategy',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: (persisted, version) => {
        const fallback = {
          strategy: DEFAULT_ANALYTICS_STRATEGY,
          advancedParallelism: DEFAULT_ADVANCED_PARALLELISM,
          strategyByServer: {} as Record<string, AnalyticsStrategy | undefined>,
          advancedParallelismByServer: {} as Record<string, number | undefined>,
        };
        if (version < 1) {
          const old = persisted as {
            strategy?: AnalyticsStrategy;
            advancedParallelism?: number;
          };
          return {
            strategy: old.strategy ?? fallback.strategy,
            advancedParallelism: clampAdvancedParallelism(old.advancedParallelism ?? fallback.advancedParallelism),
            strategyByServer: fallback.strategyByServer,
            advancedParallelismByServer: fallback.advancedParallelismByServer,
          };
        }
        const current = persisted as Partial<typeof fallback>;
        return {
          strategy: current.strategy ?? fallback.strategy,
          advancedParallelism: clampAdvancedParallelism(current.advancedParallelism ?? fallback.advancedParallelism),
          strategyByServer: current.strategyByServer ?? fallback.strategyByServer,
          advancedParallelismByServer: current.advancedParallelismByServer ?? fallback.advancedParallelismByServer,
        };
      },
      partialize: s => ({
        strategy: s.strategy,
        advancedParallelism: s.advancedParallelism,
        strategyByServer: s.strategyByServer,
        advancedParallelismByServer: s.advancedParallelismByServer,
      }),
    },
  ),
);
