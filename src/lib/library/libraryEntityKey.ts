export type LibraryEntityIdentity = {
  id: string;
  serverId?: string | null;
};

/** UI identity for library entities whose raw Subsonic ids are only server-local. */
export function libraryEntityKey(entity: LibraryEntityIdentity): string {
  return entity.serverId ? `${entity.serverId}:${entity.id}` : entity.id;
}
