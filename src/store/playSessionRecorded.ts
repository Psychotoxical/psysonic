export type PlaySessionRecordedDetail = {
  serverId: string;
  trackId: string;
  startedAtMs: number;
};

const EVENT_NAME = 'psysonic:play-session-recorded';

export function emitPlaySessionRecorded(detail: PlaySessionRecordedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PlaySessionRecordedDetail>(EVENT_NAME, { detail }));
}

export function onPlaySessionRecorded(
  listener: (detail: PlaySessionRecordedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (evt: Event) => {
    const ce = evt as CustomEvent<PlaySessionRecordedDetail>;
    if (!ce?.detail) return;
    listener(ce.detail);
  };
  window.addEventListener(EVENT_NAME, wrapped as EventListener);
  return () => window.removeEventListener(EVENT_NAME, wrapped as EventListener);
}
