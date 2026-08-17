use super::*;

/// In-memory `ProgressEmitter` that records every event for assertion.
#[derive(Default)]
struct MockEmitter {
    progress: Mutex<Vec<ProgressPayload>>,
    track_switched: Mutex<Vec<f64>>,
    formats: Mutex<Vec<crate::decode::AudioFormatEvent>>,
    ended: std::sync::atomic::AtomicUsize,
}

impl MockEmitter {
    fn progress_count(&self) -> usize {
        self.progress.lock().unwrap().len()
    }
    fn ended_count(&self) -> usize {
        self.ended.load(Ordering::SeqCst)
    }
    fn track_switched_count(&self) -> usize {
        self.track_switched.lock().unwrap().len()
    }
    fn last_progress_time(&self) -> Option<f64> {
        self.progress.lock().unwrap().last().map(|p| p.current_time)
    }
}

impl ProgressEmitter for Arc<MockEmitter> {
    fn emit_progress(&self, payload: ProgressPayload) {
        self.progress.lock().unwrap().push(payload);
    }
    fn emit_track_switched(&self, duration_secs: f64) {
        self.track_switched.lock().unwrap().push(duration_secs);
    }
    fn emit_ended(&self) {
        self.ended.fetch_add(1, Ordering::SeqCst);
    }
    fn emit_format(&self, ev: crate::decode::AudioFormatEvent) {
        self.formats.lock().unwrap().push(ev);
    }
}

/// Bundle of every Arc<…> the spawn function needs, with sane defaults.
struct TaskHarness {
    gen: u64,
    gen_counter: Arc<AtomicU64>,
    current: Arc<Mutex<AudioCurrent>>,
    chained: Arc<Mutex<Option<ChainedInfo>>>,
    crossfade_enabled: Arc<AtomicBool>,
    crossfade_secs: Arc<AtomicU32>,
    autodj_suppress: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    current_source_done: CurrentSourceDone,
    samples_played: Arc<AtomicU64>,
    sample_rate: Arc<AtomicU32>,
    channels: Arc<AtomicU32>,
    gapless_switch_at: Arc<AtomicU64>,
    playback_url: Arc<Mutex<Option<String>>>,
    stream_playback_armed: Arc<AtomicBool>,
    playback_rate: PlaybackRateAtomics,
}

impl TaskHarness {
    fn new(duration_secs: f64) -> Self {
        let done = Arc::new(AtomicBool::new(false));
        let current = AudioCurrent {
            sink: None,
            duration_secs,
            seek_offset: 0.0,
            play_started: None,
            paused_at: None,
            replay_gain_linear: 1.0,
            base_volume: 1.0,
            fadeout_trigger: None,
            fadeout_samples: None,
        };
        Self {
            gen: 1,
            gen_counter: Arc::new(AtomicU64::new(1)),
            current: Arc::new(Mutex::new(current)),
            chained: Arc::new(Mutex::new(None)),
            crossfade_enabled: Arc::new(AtomicBool::new(false)),
            crossfade_secs: Arc::new(AtomicU32::new(0f32.to_bits())),
            autodj_suppress: Arc::new(AtomicBool::new(false)),
            current_source_done: Arc::new(Mutex::new(Some((1, done.clone())))),
            done,
            samples_played: Arc::new(AtomicU64::new(0)),
            sample_rate: Arc::new(AtomicU32::new(44_100)),
            channels: Arc::new(AtomicU32::new(2)),
            gapless_switch_at: Arc::new(AtomicU64::new(0)),
            playback_url: Arc::new(Mutex::new(None)),
            stream_playback_armed: Arc::new(AtomicBool::new(true)),
            playback_rate: PlaybackRateAtomics::new(),
        }
    }

    fn spawn_with(&self, emitter: Arc<MockEmitter>) {
        spawn_progress_task(
            self.gen,
            self.gen_counter.clone(),
            self.current.clone(),
            self.chained.clone(),
            self.crossfade_enabled.clone(),
            self.crossfade_secs.clone(),
            self.autodj_suppress.clone(),
            self.current_source_done.clone(),
            emitter,
            None,
            self.samples_played.clone(),
            self.sample_rate.clone(),
            self.channels.clone(),
            self.gapless_switch_at.clone(),
            self.playback_url.clone(),
            self.stream_playback_armed.clone(),
            self.playback_rate.clone(),
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn progress_emits_buffering_while_stream_not_armed() {
    let h = TaskHarness::new(240.0);
    h.stream_playback_armed.store(false, Ordering::SeqCst);
    h.samples_played.store(441_000, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        emitter.progress.lock().unwrap().iter().any(|p| p.buffering),
        "progress payload must flag HTTP stream buffering before armed"
    );
    h.gen_counter.store(99, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn legacy_stream_holds_progress_at_zero_until_armed() {
    let h = TaskHarness::new(240.0);
    h.stream_playback_armed.store(false, Ordering::SeqCst);
    h.samples_played.store(441_000, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        emitter.last_progress_time().unwrap_or(0.0) < 0.01,
        "progress must stay at 0 while legacy stream is buffering"
    );
    assert!(
        emitter.progress.lock().unwrap().iter().any(|p| p.buffering),
        "progress payload must flag legacy stream buffering"
    );
    h.stream_playback_armed.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        emitter.last_progress_time().unwrap_or(0.0) > 4.0,
        "progress should follow samples once armed (got {:?})",
        emitter.last_progress_time()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn task_breaks_immediately_when_generation_already_changed() {
    let h = TaskHarness::new(120.0);
    h.gen_counter.store(99, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(emitter.progress_count(), 0);
    assert_eq!(emitter.ended_count(), 0);
    assert_eq!(emitter.track_switched_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn radio_with_dur_zero_emits_ended_when_done_flag_flips() {
    let h = TaskHarness::new(0.0);
    h.done.store(true, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(emitter.ended_count(), 1, "audio:ended must fire");
    assert_eq!(
        emitter.progress_count(),
        0,
        "no progress emit before exhaustion"
    );
    assert!(h.gen_counter.load(Ordering::SeqCst) > h.gen);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn task_emits_progress_payload_with_duration_after_first_tick() {
    let h = TaskHarness::new(120.0);
    let played = (5.0 * 44_100.0 * 2.0) as u64;
    h.samples_played.store(played, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    let first_payload = {
        let payloads = emitter.progress.lock().unwrap();
        assert!(!payloads.is_empty(), "first tick must emit progress");
        payloads[0].clone()
    };
    assert_eq!(first_payload.duration, 120.0);
    assert!(first_payload.current_time >= 0.0 && first_payload.current_time <= 120.0);
    h.gen_counter.store(99, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn done_with_chained_info_swaps_to_chain_and_emits_track_switched() {
    let h = TaskHarness::new(120.0);
    h.done.store(true, Ordering::SeqCst);
    let chain_url = "psysonic-local:///next/track.flac".to_string();
    let chained_done = Arc::new(AtomicBool::new(false));
    *h.chained.lock().unwrap() = Some(ChainedInfo {
        url: chain_url.clone(),
        analysis_track_id: Some("next-track".into()),
        server_id: Some("srv-1".into()),
        generation: 1,
        raw_bytes: Arc::new(Vec::new()),
        resolved_format: Some(crate::decode::ResolvedCodecInfo {
            codec_name: "flac",
            sample_rate: Some(96_000),
            bits_per_sample: Some(16),
            channels: Some(1),
            lossless: true,
        }),
        output_rate: 96_000,
        output_channels: 1,
        duration_secs: 200.0,
        replay_gain_linear: 1.0,
        base_volume: 1.0,
        source_done: chained_done.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
        sample_counter: Arc::new(AtomicU64::new(0)),
    });
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(emitter.track_switched_count(), 1);
    assert_eq!(emitter.track_switched.lock().unwrap()[0], 200.0);
    assert_eq!(emitter.ended_count(), 0);
    assert_eq!(*h.playback_url.lock().unwrap(), Some(chain_url));
    assert!(h.gapless_switch_at.load(Ordering::SeqCst) > 0);
    assert_eq!(h.sample_rate.load(Ordering::Relaxed), 96_000);
    assert_eq!(h.channels.load(Ordering::Relaxed), 1);
    {
        let formats = emitter.formats.lock().unwrap();
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].codec, "flac");
        assert_eq!(formats[0].track_id.as_deref(), Some("next-track"));
        assert_eq!(formats[0].server_id.as_deref(), Some("srv-1"));
    }
    chained_done.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(emitter.ended_count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn done_without_chain_emits_ended_immediately() {
    let h = TaskHarness::new(120.0);
    h.done.store(true, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(emitter.ended_count(), 1);
    assert_eq!(emitter.track_switched_count(), 0);
    assert!(h.gen_counter.load(Ordering::SeqCst) > h.gen);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn replacement_source_done_flag_drives_end_detection_in_same_generation() {
    let h = TaskHarness::new(120.0);
    let replacement_done = Arc::new(AtomicBool::new(false));
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    *h.current_source_done.lock().unwrap() = Some((h.gen, replacement_done.clone()));
    replacement_done.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(emitter.ended_count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn near_end_without_crossfade_waits_for_source_done() {
    let h = TaskHarness::new(120.0);
    let played = (120.0 * 44_100.0 * 2.0) as u64;
    h.samples_played.store(played, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(emitter.ended_count(), 0);
    h.done.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(emitter.ended_count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn near_end_with_crossfade_emits_ended_on_timer() {
    let h = TaskHarness::new(120.0);
    h.crossfade_enabled.store(true, Ordering::SeqCst);
    h.crossfade_secs.store(5.0f32.to_bits(), Ordering::SeqCst);
    let played = (117.0 * 44_100.0 * 2.0) as u64;
    h.samples_played.store(played, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert_eq!(emitter.ended_count(), 1);
    assert!(h.gen_counter.load(Ordering::SeqCst) > h.gen);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn autodj_suppress_does_not_fire_crossfade_timer() {
    let h = TaskHarness::new(120.0);
    h.crossfade_enabled.store(true, Ordering::SeqCst);
    h.crossfade_secs.store(5.0f32.to_bits(), Ordering::SeqCst);
    h.autodj_suppress.store(true, Ordering::SeqCst);
    let played = (117.0 * 44_100.0 * 2.0) as u64;
    h.samples_played.store(played, Ordering::SeqCst);
    let emitter = Arc::new(MockEmitter::default());
    h.spawn_with(emitter.clone());
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert_eq!(emitter.ended_count(), 0);
    h.done.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(emitter.ended_count(), 1);
}
