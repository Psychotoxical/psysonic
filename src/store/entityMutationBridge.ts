interface EntityMutationBridge {
  discardServer(serverId: string): void;
}

let bridge: EntityMutationBridge | null = null;

export function registerEntityMutationBridge(impl: EntityMutationBridge): void {
  bridge = impl;
}

export function discardPendingEntityMutationsForServer(serverId: string): void {
  bridge?.discardServer(serverId);
}
