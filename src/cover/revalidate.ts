import type { CoverArtId, CoverRevalidateReason } from './types';

export async function coverRevalidateEnqueueIpc(
  _serverId: string,
  _coverArtId: CoverArtId,
  _reason: CoverRevalidateReason,
): Promise<void> {}
