/// Idle gap after which the next play starts a new listening session.
pub(crate) const LISTENING_SESSION_GAP_MS: i64 = 30 * 60 * 1000;

#[derive(Clone, Copy)]
pub(crate) struct PlaySpan {
    pub started_at_ms: i64,
    pub listened_sec: f64,
}

fn play_end_ms(span: PlaySpan) -> i64 {
    span.started_at_ms + (span.listened_sec * 1000.0) as i64
}

pub(crate) struct ListeningSessionStats {
    pub count: u32,
    /// Listened seconds summed inside the busiest session — deliberately not
    /// the wall-clock span, so sub-gap pauses cannot inflate the number.
    pub longest_listened_sec: f64,
}

pub(crate) fn listening_session_stats(plays: &[PlaySpan]) -> ListeningSessionStats {
    if plays.is_empty() {
        return ListeningSessionStats { count: 0, longest_listened_sec: 0.0 };
    }
    let mut sorted = plays.to_vec();
    sorted.sort_by_key(|p| p.started_at_ms);
    let mut sessions = 1u32;
    let mut prev_end = play_end_ms(sorted[0]);
    let mut current_listened = sorted[0].listened_sec;
    let mut longest_listened = current_listened;
    for span in sorted.iter().skip(1) {
        if span.started_at_ms - prev_end > LISTENING_SESSION_GAP_MS {
            sessions += 1;
            current_listened = 0.0;
        }
        current_listened += span.listened_sec;
        longest_listened = longest_listened.max(current_listened);
        prev_end = prev_end.max(play_end_ms(*span));
    }
    ListeningSessionStats { count: sessions, longest_listened_sec: longest_listened }
}

pub(crate) fn count_listening_sessions(plays: &[PlaySpan]) -> u32 {
    listening_session_stats(plays).count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clusters_by_thirty_minute_gap() {
    let plays = vec![
            PlaySpan { started_at_ms: 0, listened_sec: 120.0 },
            PlaySpan { started_at_ms: 5 * 60 * 1000, listened_sec: 120.0 },
            PlaySpan {
                started_at_ms: 45 * 60 * 1000,
                listened_sec: 120.0,
            },
        ];
        assert_eq!(count_listening_sessions(&plays), 2);
    }

    #[test]
    fn empty_plays_is_zero_sessions() {
        assert_eq!(count_listening_sessions(&[]), 0);
        let stats = listening_session_stats(&[]);
        assert_eq!(stats.count, 0);
        assert_eq!(stats.longest_listened_sec, 0.0);
    }

    #[test]
    fn longest_session_sums_listened_time_not_wall_clock() {
        // Session 1: two plays with a 10-minute pause between them — the pause
        // must not count, so the session weighs 120 + 180 = 300 s.
        // Session 2 (after a >30-minute gap): a single 240 s play.
        let plays = vec![
            PlaySpan { started_at_ms: 0, listened_sec: 120.0 },
            PlaySpan { started_at_ms: 12 * 60 * 1000, listened_sec: 180.0 },
            PlaySpan { started_at_ms: 60 * 60 * 1000, listened_sec: 240.0 },
        ];
        let stats = listening_session_stats(&plays);
        assert_eq!(stats.count, 2);
        assert!((stats.longest_listened_sec - 300.0).abs() < 1e-6);
    }
}
