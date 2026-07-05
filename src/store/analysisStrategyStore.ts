import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  clampAdvancedParallelism,
  DEFAULT_ADVANCED_PARALLELISM,
  DEFAULT_ANALYTICS_STRATEGY,
  type AnalyticsStrategy,
} from '@/lib/library/analysisStrategy';
import { useAuthStore } from './authStore';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import type { ServerProfile } from './authStoreTypes';

const resolveStrategyKey = (serverId: string): string => {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (!server) return serverId;
  return serverIndexKeyFromUrl(server.url) || serverId;
};

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
  migrateServerOverrides: (servers: ServerProfile[]) => void;
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
          strategyByServer: { ...s.strategyByServer, [resolveStrategyKey(serverId)]: strategy },
        })),
      setServerAdvancedParallelism: (serverId, workers) =>
        set(s => ({
          advancedParallelismByServer: {
            ...s.advancedParallelismByServer,
            [resolveStrategyKey(serverId)]: clampAdvancedParallelism(workers),
          },
        })),
      clearServerOverrides: (serverId) =>
        set(s => {
          const key = resolveStrategyKey(serverId);
          const { [serverId]: _, [key]: __, ...strategyByServer } = s.strategyByServer;
          const { [serverId]: ___, [key]: ____, ...advancedParallelismByServer } = s.advancedParallelismByServer;
          return { strategyByServer, advancedParallelismByServer };
        }),
      migrateServerOverrides: (servers) =>
        set(s => {
          if (servers.length === 0) return {};
          let changed = false;
          const strategyByServer = { ...s.strategyByServer };
          const advancedParallelismByServer = { ...s.advancedParallelismByServer };
          for (const server of servers) {
            const key = serverIndexKeyFromUrl(server.url) || server.id;
            if (key === server.id) continue;
            const legacyStrategy = strategyByServer[server.id];
            const nextStrategy = strategyByServer[key];
            if (legacyStrategy !== undefined && nextStrategy !== undefined) {
              delete strategyByServer[server.id];
              changed = true;
            } else if (legacyStrategy !== undefined && nextStrategy === undefined) {
              strategyByServer[key] = legacyStrategy;
              delete strategyByServer[server.id];
              changed = true;
            }

            const legacyParallel = advancedParallelismByServer[server.id];
            const nextParallel = advancedParallelismByServer[key];
            if (legacyParallel !== undefined && nextParallel !== undefined) {
              delete advancedParallelismByServer[server.id];
              changed = true;
            } else if (legacyParallel !== undefined && nextParallel === undefined) {
              advancedParallelismByServer[key] = legacyParallel;
              delete advancedParallelismByServer[server.id];
              changed = true;
            }
          }
          return changed ? { strategyByServer, advancedParallelismByServer } : {};
        }),
      getStrategyForServer: serverId => {
        if (!serverId) return DEFAULT_ANALYTICS_STRATEGY;
        const key = resolveStrategyKey(serverId);
        return get().strategyByServer[key] ?? get().strategyByServer[serverId] ?? get().strategy;
      },
      getAdvancedParallelismForServer: serverId => {
        if (!serverId) return DEFAULT_ADVANCED_PARALLELISM;
        const key = resolveStrategyKey(serverId);
        return get().advancedParallelismByServer[key]
          ?? get().advancedParallelismByServer[serverId]
          ?? get().advancedParallelism;
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
