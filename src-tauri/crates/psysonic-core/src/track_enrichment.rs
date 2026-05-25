//! Shared types for client-side track enrichment (oximedia BPM / mood).

/// Which analysis facts still need to be computed for the current content hash.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrackEnrichmentPlan {
    pub need_bpm: bool,
    pub need_valence: bool,
    pub need_arousal: bool,
    /// Raw oximedia mood scores JSON (`{"calm":0.4,...}`).
    pub need_moods: bool,
}

impl TrackEnrichmentPlan {
    pub fn any(self) -> bool {
        self.need_bpm || self.need_valence || self.need_arousal || self.need_moods
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TrackEnrichmentIntFact {
    pub value: i64,
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct TrackEnrichmentRealFact {
    pub value: f64,
    pub confidence: f32,
}

/// Facts produced by oximedia for persistence via the library port.
#[derive(Debug, Clone, Default)]
pub struct TrackEnrichmentFacts {
    pub bpm: Option<TrackEnrichmentIntFact>,
    pub valence: Option<TrackEnrichmentRealFact>,
    pub arousal: Option<TrackEnrichmentRealFact>,
    /// Oximedia `MoodResult.moods` serialized as JSON object (label → score).
    pub moods: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackEnrichmentOutcome {
    Applied,
    /// Nothing to compute for the current content hash.
    SkippedComplete,
    /// Oximedia analysis or persistence failed; facts were not stored (retry on next seed).
    Failed,
    SkippedNoServer,
    SkippedNoPort,
}

type PlanFn = std::sync::Arc<
    dyn Fn(&str, &str, &str) -> TrackEnrichmentPlan + Send + Sync + 'static,
>;
type StoreFn = std::sync::Arc<
    dyn Fn(&str, &str, &str, &TrackEnrichmentFacts) -> Result<(), String> + Send + Sync + 'static,
>;

/// Library↔analysis port: plan missing facts and store computed results without
/// pulling `psysonic-library` into `psysonic-analysis`.
#[derive(Clone)]
pub struct TrackEnrichmentPort {
    plan: PlanFn,
    store: StoreFn,
}

impl TrackEnrichmentPort {
    pub fn new<P, S>(plan: P, store: S) -> Self
    where
        P: Fn(&str, &str, &str) -> TrackEnrichmentPlan + Send + Sync + 'static,
        S: Fn(&str, &str, &str, &TrackEnrichmentFacts) -> Result<(), String>
            + Send
            + Sync
            + 'static,
    {
        Self {
            plan: std::sync::Arc::new(plan),
            store: std::sync::Arc::new(store),
        }
    }

    pub fn plan(&self, server_id: &str, track_id: &str, content_hash: &str) -> TrackEnrichmentPlan {
        (self.plan)(server_id, track_id, content_hash)
    }

    pub fn store(
        &self,
        server_id: &str,
        track_id: &str,
        content_hash: &str,
        facts: &TrackEnrichmentFacts,
    ) -> Result<(), String> {
        (self.store)(server_id, track_id, content_hash, facts)
    }
}
