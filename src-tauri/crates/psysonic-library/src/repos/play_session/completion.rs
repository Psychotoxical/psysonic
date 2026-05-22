pub(crate) const MIN_LISTENED_SEC: f64 = 10.0;
pub(crate) const FULL_COMPLETION_RATIO: f64 = 0.70;

pub(crate) fn effective_duration_sec(db_duration_sec: i64, hint: Option<i64>) -> i64 {
    let hint = hint.filter(|d| *d > 0).unwrap_or(0);
    if db_duration_sec > 0 && hint > 0 {
        return db_duration_sec.max(hint);
    }
    if db_duration_sec > 0 {
        return db_duration_sec;
    }
    hint
}

pub(crate) fn completion_from_position(position_max_sec: f64, duration_sec: i64) -> &'static str {
    if duration_sec <= 0 {
        return "partial";
    }
    if position_max_sec / duration_sec as f64 >= FULL_COMPLETION_RATIO {
        "full"
    } else {
        "partial"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_threshold_at_seventy_percent() {
        assert_eq!(completion_from_position(70.0, 100), "full");
        assert_eq!(completion_from_position(69.0, 100), "partial");
    }

    #[test]
    fn zero_duration_is_always_partial() {
        assert_eq!(completion_from_position(100.0, 0), "partial");
    }

    #[test]
    fn effective_duration_prefers_max_of_db_and_hint() {
        assert_eq!(effective_duration_sec(1, Some(300)), 300);
        assert_eq!(effective_duration_sec(200, Some(100)), 200);
        assert_eq!(effective_duration_sec(0, Some(240)), 240);
    }
}
