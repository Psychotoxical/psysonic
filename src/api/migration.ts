import { invoke } from '@tauri-apps/api/core';

export interface ServerIndexMapping {
  legacyId: string;
  indexKey: string;
}

export interface MigrationInspectScope {
  totalLegacyRows: number;
  skippedUnknownServerRows: number;
  tables: Record<string, number>;
}

export interface MigrationInspectReport {
  needsMigration: boolean;
  hasSkippedUnknownServerRows: boolean;
  canRun: boolean;
  warnings: string[];
  unmappedEmptyBucket: boolean;
  library: MigrationInspectScope;
  analysis: MigrationInspectScope;
  mappings: ServerIndexMapping[];
}

export interface MigrationProgressEvent {
  stage: string;
  table: string;
  done: number;
  total: number;
}

export interface MigrationRunScope {
  importedRows: number;
  sourceRows: number;
  skippedUnknownServerRows: number;
}

export interface MigrationRunResult {
  library: MigrationRunScope;
  analysis: MigrationRunScope;
  hasSkippedUnknownServerRows: boolean;
  switched: boolean;
  backupRemoved: boolean;
}

export function migrationInspect(
  mappings: ServerIndexMapping[],
): Promise<MigrationInspectReport> {
  return invoke<MigrationInspectReport>('migration_inspect', { mappings });
}

export function migrationRun(
  mappings: ServerIndexMapping[],
): Promise<MigrationRunResult> {
  return invoke<MigrationRunResult>('migration_run', { mappings });
}
