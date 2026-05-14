/**
 * Classify a Rust-side seek error message as "retryable" — set when the audio
 * pipeline is still settling (sink not yet bound, a previous seek still
 * draining, codec hasn't reported seekability) rather than a hard failure.
 * Callers retry these with a bounded interval; everything else surfaces a
 * single toast and aborts.
 */
export function isRecoverableSeekError(msg: string): boolean {
  return msg.includes('not seekable')
    || msg.includes('audio sink not ready')
    || msg.includes('audio seek busy')
    || msg.includes('audio seek timeout');
}
