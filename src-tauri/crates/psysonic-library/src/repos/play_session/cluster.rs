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

pub(crate) fn count_listening_sessions(plays: &[PlaySpan]) -> u32 {
    if plays.is_empty() {
        return 0;
    }
    let mut sorted = plays.to_vec();
    sorted.sort_by_key(|p| p.started_at_ms);
    let mut sessions = 1u32;
    let mut prev_end = play_end_ms(sorted[0]);
    for span in sorted.iter().skip(1) {
        if span.started_at_ms - prev_end > LISTENING_SESSION_GAP_MS {
            sessions += 1;
        }
        prev_end = prev_end.max(play_end_ms(*span));
    }
    sessions
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
    }
}
