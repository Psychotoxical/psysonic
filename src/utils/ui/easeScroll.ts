/**
 * Duration-based ease-out scroll animator.
 *
 * Animates scrollTop from the current position to the target over a fixed
 * duration using a cubic ease-out curve. Calling scrollTo() mid-flight
 * restarts cleanly from wherever the container currently sits, so fast
 * line changes never look jerky or skip.
 */
export class EaseScroller {
  private container : HTMLElement;
  private startY    = 0;
  private targetY   = 0;
  private startTime = 0;
  private rafId: number | null = null;

  private readonly duration: number;

  constructor(container: HTMLElement, duration = 650) {
    this.container = container;
    this.targetY   = container.scrollTop;
    this.duration  = duration;
  }

  scrollTo(y: number) {
    this.startY    = this.container.scrollTop;
    this.targetY   = Math.max(0, y);
    this.startTime = performance.now();
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  jump(y: number) {
    this.stop();
    this.container.scrollTop = y;
    this.targetY = y;
  }

  private tick = (now: number) => {
    const t    = Math.min((now - this.startTime) / this.duration, 1);
    const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
    this.container.scrollTop = this.startY + (this.targetY - this.startY) * ease;
    if (t < 1) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.container.scrollTop = this.targetY;
      this.rafId = null;
    }
  };
}

/**
 * Compute the scroll position that places `el` at `fraction` from the top
 * of `container` (0 = top edge, 0.35 = Apple Music-style, 0.5 = centre).
 */
export function targetForFraction(
  container: HTMLElement,
  el       : HTMLElement,
  fraction  = 0.35,
): number {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  return container.scrollTop + (eRect.top - cRect.top) - cRect.height * fraction + eRect.height / 2;
}
