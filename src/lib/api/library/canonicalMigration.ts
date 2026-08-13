import { commands } from '@/generated/bindings';
import type { CanonicalMigrationDto } from '@/generated/bindings';
import { serverIndexKeyForId } from './internal';

async function unwrapCanonicalMigration(
  result: Awaited<ReturnType<typeof commands.libraryNavidromeCanonicalInspect>>,
): Promise<CanonicalMigrationDto> {
  if (result.status === 'error') throw new Error(result.error);
  return result.data;
}

export async function libraryNavidromeCanonicalInspect(
  serverId: string,
): Promise<CanonicalMigrationDto> {
  return unwrapCanonicalMigration(
    await commands.libraryNavidromeCanonicalInspect(serverIndexKeyForId(serverId)),
  );
}

export async function libraryNavidromeCanonicalRewrite(
  serverId: string,
): Promise<CanonicalMigrationDto> {
  return unwrapCanonicalMigration(
    await commands.libraryNavidromeCanonicalRewrite(serverIndexKeyForId(serverId)),
  );
}

export async function libraryNavidromeCanonicalAckFrontend(
  serverId: string,
): Promise<CanonicalMigrationDto> {
  return unwrapCanonicalMigration(
    await commands.libraryNavidromeCanonicalAckFrontend(serverIndexKeyForId(serverId)),
  );
}

export async function libraryNavidromeCanonicalFinalize(
  serverId: string,
): Promise<CanonicalMigrationDto> {
  return unwrapCanonicalMigration(
    await commands.libraryNavidromeCanonicalFinalize(serverIndexKeyForId(serverId)),
  );
}

export type { CanonicalIdMappingDto, CanonicalMigrationDto } from '@/generated/bindings';
