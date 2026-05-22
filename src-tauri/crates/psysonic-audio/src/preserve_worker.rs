//! Background worker for preserve-pitch DSP (phase vocoder is too heavy for cpal callback).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use pitch_shift::{Shifter, TOTAL_F32};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use rodio::Source;

use crate::playback_rate::{
    effective_pitch, is_effect_active, preserve_out_samples, PlaybackRateAtomics, PRESERVE_MAKEUP_GAIN,
    uses_preserve_dsp,
};

const FRAME_BLOCK: usize = 128;
const PRESERVE_OUT_MAX: usize = 1023;
const PRESERVE_PARAM_EPS_PITCH: f32 = 0.05;
const PRESERVE_PARAM_EPS_SPEED: f32 = 0.001;
const RB_MIN_CAPACITY: usize = 44_100 * 2 * 2; // ~2 s stereo @ 44.1 kHz
const RB_TARGET_FILL: f32 = 0.6;
const RB_FILL_HIGH: f32 = 0.88;
const FORWARD_BATCH: usize = 4096;
const WORKER_IDLE_SLEEP: Duration = Duration::from_millis(1);

enum WorkerCmd {
    Seek(Duration),
    Handback,
    Shutdown,
}

struct PreserveWorkerEnv {
    atomics: PlaybackRateAtomics,
    sample_rate: u32,
    channels: u16,
    capacity: usize,
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    cmd_rx: mpsc::Receiver<WorkerCmd>,
}

pub(crate) struct PreserveOffload {
    cons: HeapCons<f32>,
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    cmd_tx: SyncSender<WorkerCmd>,
    thread: Option<JoinHandle<()>>,
}

impl PreserveOffload {
    pub(crate) fn spawn<S: Source<Item = f32> + Send + 'static>(
        inner: S,
        atomics: PlaybackRateAtomics,
        sample_rate: u32,
        channels: u16,
        handback_tx: SyncSender<S>,
    ) -> Self {
        let cap = ((sample_rate as f32 * channels as f32 * 2.5) as usize).max(RB_MIN_CAPACITY);
        let rb = HeapRb::<f32>::new(cap);
        let (prod, cons) = rb.split();
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let (cmd_tx, cmd_rx) = mpsc::sync_channel::<WorkerCmd>(8);
        let stop_worker = stop.clone();
        let done_worker = done.clone();
        let thread = thread::Builder::new()
            .name("psysonic-preserve-pitch".into())
            .spawn(move || {
                worker_main(
                    inner,
                    prod,
                    PreserveWorkerEnv {
                        atomics,
                        sample_rate,
                        channels,
                        capacity: cap,
                        stop: stop_worker,
                        done: done_worker,
                        cmd_rx,
                    },
                    handback_tx,
                );
            })
            .expect("spawn preserve-pitch worker");

        Self {
            cons,
            stop,
            done,
            cmd_tx,
            thread: Some(thread),
        }
    }

    pub(crate) fn pop(&mut self) -> Option<f32> {
        self.cons.try_pop()
    }

    pub(crate) fn is_done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    pub(crate) fn request_seek(&self, pos: Duration) {
        let _ = self.cmd_tx.send(WorkerCmd::Seek(pos));
    }

    pub(crate) fn request_handback(&self) {
        let _ = self.cmd_tx.send(WorkerCmd::Handback);
    }

    pub(crate) fn drain(&mut self) {
        while self.cons.try_pop().is_some() {}
    }

    pub(crate) fn join(mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.cmd_tx.send(WorkerCmd::Shutdown);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for PreserveOffload {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.cmd_tx.send(WorkerCmd::Shutdown);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct PreserveChannelState {
    shifter: Shifter<Box<[f32; TOTAL_F32]>>,
    frame: Vec<f32>,
}

impl PreserveChannelState {
    fn new() -> Self {
        Self {
            shifter: Shifter::new(Box::new([0.0; TOTAL_F32])),
            frame: Vec::with_capacity(FRAME_BLOCK),
        }
    }

    fn reset(&mut self) {
        self.shifter = Shifter::new(Box::new([0.0; TOTAL_F32]));
        self.frame.clear();
    }

    fn reset_shifter(&mut self) {
        self.shifter = Shifter::new(Box::new([0.0; TOTAL_F32]));
    }
}

struct PreserveState {
    channels: Vec<PreserveChannelState>,
    pending: VecDeque<f32>,
    channel_idx: usize,
    last_pitch: f32,
    last_speed: f32,
}

impl PreserveState {
    fn for_channels(count: u16) -> Self {
        let n = count.max(1) as usize;
        Self {
            channels: (0..n).map(|_| PreserveChannelState::new()).collect(),
            pending: VecDeque::new(),
            channel_idx: 0,
            last_pitch: f32::NAN,
            last_speed: f32::NAN,
        }
    }

    fn reset(&mut self, channels: u16) {
        let n = channels.max(1) as usize;
        if self.channels.len() != n {
            self.channels = (0..n).map(|_| PreserveChannelState::new()).collect();
        } else {
            for ch in &mut self.channels {
                ch.reset();
            }
        }
        self.pending.clear();
        self.channel_idx = 0;
        self.last_pitch = f32::NAN;
        self.last_speed = f32::NAN;
    }

    fn reset_if_params_changed(&mut self, pitch: f32, speed: f32) {
        if self.last_pitch.is_nan() {
            self.last_pitch = pitch;
            self.last_speed = speed;
            return;
        }
        if (pitch - self.last_pitch).abs() > PRESERVE_PARAM_EPS_PITCH
            || (speed - self.last_speed).abs() > PRESERVE_PARAM_EPS_SPEED
        {
            for ch in &mut self.channels {
                ch.reset_shifter();
            }
            self.pending.clear();
            self.last_pitch = pitch;
            self.last_speed = speed;
        }
    }

    fn process_block(&mut self, speed: f32, pitch: f32, sample_rate: f32) {
        self.reset_if_params_changed(pitch, speed);
        let out_n = preserve_out_samples(speed).clamp(1, PRESERVE_OUT_MAX);
        let ch_count = self.channels.len();
        let mut outs: Vec<&[f32]> = Vec::with_capacity(ch_count);
        for ch in &mut self.channels {
            if ch.frame.len() == FRAME_BLOCK {
                let out = ch.shifter.shift(&ch.frame, pitch, out_n, sample_rate);
                outs.push(out);
                ch.frame.clear();
            }
        }
        if outs.len() != ch_count {
            return;
        }
        for i in 0..out_n {
            for out_slice in &outs {
                if let Some(&sample) = out_slice.get(i) {
                    self.pending
                        .push_back((sample * PRESERVE_MAKEUP_GAIN).clamp(-1.0, 1.0));
                }
            }
        }
    }
}

fn ring_fill(prod: &HeapProd<f32>, capacity: usize) -> f32 {
    1.0 - prod.vacant_len() as f32 / capacity as f32
}

fn push_pending(prod: &mut HeapProd<f32>, pending: &mut VecDeque<f32>, stop: &AtomicBool) {
    while let Some(&s) = pending.front() {
        if stop.load(Ordering::Acquire) {
            return;
        }
        if prod.try_push(s).is_ok() {
            pending.pop_front();
        } else {
            return;
        }
    }
}

fn forward_passthrough<S: Source<Item = f32>>(
    inner: &mut S,
    prod: &mut HeapProd<f32>,
    capacity: usize,
    stop: &AtomicBool,
) -> bool {
    let target = (capacity as f32 * RB_TARGET_FILL) as usize;
    let mut pushed = 0usize;
    while prod.occupied_len() < target && pushed < FORWARD_BATCH {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        let Some(s) = inner.next() else {
            return false;
        };
        if prod.try_push(s).is_err() {
            break;
        }
        pushed += 1;
    }
    true
}

fn worker_main<S: Source<Item = f32> + Send>(
    mut inner: S,
    mut prod: HeapProd<f32>,
    env: PreserveWorkerEnv,
    handback_tx: SyncSender<S>,
) {
    let PreserveWorkerEnv {
        atomics,
        sample_rate,
        channels,
        capacity,
        stop,
        done,
        cmd_rx,
    } = env;
    let ch_count = channels.max(1) as usize;
    let mut preserve = PreserveState::for_channels(channels);
    let sr = sample_rate as f32;

    'run: while !stop.load(Ordering::Acquire) {
        if let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                WorkerCmd::Shutdown => break,
                WorkerCmd::Handback => {
                    push_pending(&mut prod, &mut preserve.pending, &stop);
                    let _ = handback_tx.send(inner);
                    done.store(true, Ordering::Release);
                    return;
                }
                WorkerCmd::Seek(pos) => {
                    let _ = inner.try_seek(pos);
                    preserve.reset(channels);
                }
            }
        }

        let use_preserve = atomics.enabled.load(Ordering::Relaxed)
            && uses_preserve_dsp(atomics.load_strategy())
            && is_effect_active(&atomics);

        if !use_preserve {
            preserve.reset(channels);
            push_pending(&mut prod, &mut preserve.pending, &stop);
            let fill = ring_fill(&prod, capacity);
            if fill >= RB_FILL_HIGH {
                match cmd_rx.recv_timeout(WORKER_IDLE_SLEEP) {
                    Ok(WorkerCmd::Shutdown) => break 'run,
                    Ok(WorkerCmd::Handback) => {
                        push_pending(&mut prod, &mut preserve.pending, &stop);
                        let _ = handback_tx.send(inner);
                        done.store(true, Ordering::Release);
                        return;
                    }
                    Ok(WorkerCmd::Seek(pos)) => {
                        let _ = inner.try_seek(pos);
                        preserve.reset(channels);
                    }
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break 'run,
                }
            }
            if !forward_passthrough(&mut inner, &mut prod, capacity, &stop) {
                break;
            }
            continue;
        }

        let fill = ring_fill(&prod, capacity);
        if fill >= RB_FILL_HIGH {
            match cmd_rx.recv_timeout(WORKER_IDLE_SLEEP) {
                Ok(WorkerCmd::Shutdown) => break 'run,
                Ok(WorkerCmd::Handback) => {
                    push_pending(&mut prod, &mut preserve.pending, &stop);
                    let _ = handback_tx.send(inner);
                    done.store(true, Ordering::Release);
                    return;
                }
                Ok(WorkerCmd::Seek(pos)) => {
                    let _ = inner.try_seek(pos);
                    preserve.reset(channels);
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break 'run,
            }
        }

        push_pending(&mut prod, &mut preserve.pending, &stop);

        if !preserve.pending.is_empty() {
            continue;
        }

        match inner.next() {
            Some(s) => {
                let ch = preserve.channel_idx;
                preserve.channels[ch].frame.push(s);
                preserve.channel_idx = (ch + 1) % ch_count;
                if preserve
                    .channels
                    .iter()
                    .all(|c| c.frame.len() >= FRAME_BLOCK)
                {
                    preserve.process_block(
                        atomics.load_speed(),
                        effective_pitch(&atomics),
                        sr,
                    );
                }
            }
            None => break,
        }
    }

    push_pending(&mut prod, &mut preserve.pending, &stop);
    done.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback_rate::STRATEGY_PRESERVE_PITCH;
    use rodio::{ChannelCount, SampleRate};
    use std::time::Duration as StdDuration;

    struct SineSource {
        remaining: usize,
        rate: u32,
    }

    impl Iterator for SineSource {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.remaining == 0 {
                return None;
            }
            self.remaining -= 1;
            Some(0.25)
        }
    }

    impl Source for SineSource {
        fn current_span_len(&self) -> Option<usize> {
            Some(self.remaining)
        }
        fn channels(&self) -> ChannelCount {
            std::num::NonZero::new(2).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            SampleRate::new(self.rate).unwrap()
        }
        fn total_duration(&self) -> Option<StdDuration> {
            Some(StdDuration::from_secs(1))
        }
    }

    #[test]
    fn worker_prefills_ring_before_done() {
        let atomics = PlaybackRateAtomics::new();
        atomics.enabled.store(true, Ordering::Relaxed);
        atomics
            .strategy
            .store(STRATEGY_PRESERVE_PITCH, Ordering::Relaxed);
        atomics.speed.store(1.25f32.to_bits(), Ordering::Relaxed);

        let src = SineSource {
            remaining: 44_100 * 2,
            rate: 44_100,
        };
        let (tx, _rx) = mpsc::sync_channel(1);
        let mut offload = PreserveOffload::spawn(src, atomics, 44_100, 2, tx);
        std::thread::sleep(Duration::from_millis(150));
        let mut got = 0usize;
        for _ in 0..10_000 {
            if let Some(s) = offload.pop() {
                got += 1;
                if got > 500 {
                    break;
                }
                let _ = s;
            } else if offload.is_done() {
                break;
            } else {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        assert!(got > 500, "expected prefetched samples, got {got}");
    }
}
