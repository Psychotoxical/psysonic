use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Player;

static SINK_VOLUME_RAMP_GEN: AtomicU64 = AtomicU64::new(0);
static TRANSPORT_SINK_VOLUME_RAMP_GEN: AtomicU64 = AtomicU64::new(0);

/// Cancel any in-flight sink-volume ramp (new ramp wins).
pub(crate) fn cancel_sink_volume_ramp() {
    SINK_VOLUME_RAMP_GEN.fetch_add(1, Ordering::SeqCst);
}

pub(crate) fn cancel_transport_sink_volume_ramp() {
    TRANSPORT_SINK_VOLUME_RAMP_GEN.fetch_add(1, Ordering::SeqCst);
}

/// Audible sink multiplier — may differ from `base_volume * replay_gain` after
/// interrupt prep or a mid-ramp correction.
pub(crate) fn sink_volume_now(sink: &Player) -> f32 {
    sink.volume().clamp(0.0, 1.0)
}

pub(crate) fn ramp_sink_volume(sink: Arc<Player>, from: f32, to: f32) {
    let from = from.clamp(0.0, 1.0);
    let to = to.clamp(0.0, 1.0);
    if (to - from).abs() < 0.002 {
        sink.set_volume(to);
        return;
    }
    let my_gen = SINK_VOLUME_RAMP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let delta = (to - from).abs();
        // Stretch large corrections to avoid audible "step down" moments.
        let (steps, step_ms): (usize, u64) = if delta > 0.30 {
            (24, 35)
        } else if delta > 0.18 {
            (18, 30)
        } else if delta > 0.10 {
            (14, 24)
        } else {
            (8, 16)
        };
        let _ = ramp_sink_volume_steps(
            sink,
            from,
            to,
            RampTiming { steps, step_ms },
            my_gen,
            &SINK_VOLUME_RAMP_GEN,
            false,
        );
    });
}

/// Linear sink-volume ramp over an explicit wall-clock duration (interrupt prep).
pub(crate) fn ramp_sink_volume_over_secs(sink: Arc<Player>, from: f32, to: f32, secs: f32) {
    let from = from.clamp(0.0, 1.0);
    let to = to.clamp(0.0, 1.0);
    if (to - from).abs() < 0.002 {
        sink.set_volume(to);
        return;
    }
    let my_gen = SINK_VOLUME_RAMP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let secs = secs.clamp(0.1, 12.0);
    let step_ms: u64 = 20;
    let steps = ((secs * 1000.0) / step_ms as f32).round().max(1.0) as usize;
    std::thread::spawn(move || {
        let _ = ramp_sink_volume_steps(
            sink,
            from,
            to,
            RampTiming { steps, step_ms },
            my_gen,
            &SINK_VOLUME_RAMP_GEN,
            false,
        );
    });
}

/// Smooth pause/resume ramp. The completion callback only runs when this ramp
/// reaches its target; a newer ramp cancels both the remaining steps and the
/// stale transport action.
pub(crate) fn ramp_sink_volume_smooth_over_secs_then(
    sink: Arc<Player>,
    from: f32,
    to: f32,
    secs: f32,
    on_complete: impl FnOnce() + Send + 'static,
) {
    let from = from.clamp(0.0, 1.0);
    let to = to.clamp(0.0, 1.0);
    if (to - from).abs() < 0.002 {
        sink.set_volume(to);
        on_complete();
        return;
    }
    let my_gen = TRANSPORT_SINK_VOLUME_RAMP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let secs = secs.clamp(0.1, 2.0);
    let step_ms: u64 = 20;
    let steps = ((secs * 1000.0) / step_ms as f32).round().max(1.0) as usize;
    std::thread::spawn(move || {
        if ramp_sink_volume_steps(
            sink,
            from,
            to,
            RampTiming { steps, step_ms },
            my_gen,
            &TRANSPORT_SINK_VOLUME_RAMP_GEN,
            true,
        ) {
            on_complete();
        }
    });
}

struct RampTiming {
    steps: usize,
    step_ms: u64,
}

fn ramp_sink_volume_steps(
    sink: Arc<Player>,
    from: f32,
    to: f32,
    timing: RampTiming,
    my_gen: u64,
    generation: &'static AtomicU64,
    smooth: bool,
) -> bool {
    for i in 1..=timing.steps {
        if generation.load(Ordering::SeqCst) != my_gen {
            return false;
        }
        let t = i as f32 / timing.steps as f32;
        let t = if smooth { t * t * (3.0 - 2.0 * t) } else { t };
        let v = from + (to - from) * t;
        sink.set_volume(v.clamp(0.0, 1.0));
        if i < timing.steps {
            std::thread::sleep(Duration::from_millis(timing.step_ms));
        }
    }
    generation.load(Ordering::SeqCst) == my_gen
}
