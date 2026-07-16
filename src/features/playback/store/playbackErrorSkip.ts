export function createGenerationGuardedPlaybackSkip(args: {
  generation: number;
  getGeneration: () => number;
  skip: () => void;
  delayMs?: number;
}): () => void {
  return () => {
    setTimeout(() => {
      if (args.getGeneration() !== args.generation) return;
      args.skip();
    }, args.delayMs ?? 1500);
  };
}
