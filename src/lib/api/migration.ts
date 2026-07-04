import { commands } from '@/generated/bindings';

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

export async function migrationInspect(
  mappings: ServerIndexMapping[],
): Promise<MigrationInspectReport> {
  const res = await commands.migrationInspect(mappings);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function migrationRun(
  mappings: ServerIndexMapping[],
): Promise<MigrationRunResult> {
  const res = await commands.migrationRun(mappings);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}
