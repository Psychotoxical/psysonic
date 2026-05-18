export function fadeOut(
  setVolume: (v: number) => void,
  from: number,
  durationMs: number,
): Promise<void> {
  return new Promise(resolve => {
    const steps = 16;
    const stepMs = durationMs / steps;
    let step = 0;
    const id = setInterval(() => {
      step++;
      setVolume(Math.max(0, from * (1 - step / steps)));
      if (step >= steps) {
        clearInterval(id);
        resolve();
      }
    }, stepMs);
  });
}
