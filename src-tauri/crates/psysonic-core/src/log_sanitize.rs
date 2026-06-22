//! Redact secrets and partially mask remote server hostnames before log lines
//! are stored or exported (PsyLab / Settings log export).

const SENSITIVE_QUERY_KEYS: &[&str] = &[
    "t", "s", "p", "token", "password", "passwd", "secret", "api_key", "apikey",
    "access_token", "refresh_token", "auth",
];

const SENSITIVE_KV_KEYS: &[&str] = &[
    "password", "passwd", "token", "secret", "api_key", "apikey", "access_token",
    "refresh_token", "authorization", "auth", "cookie", "x-api-key",
    "cf-access-client-secret", "cf-access-client-id", "x-auth-token",
];

/// Sanitize one runtime log line for display and export.
pub fn sanitize_log_line(line: &str) -> String {
    let mut out = redact_bearer_tokens(line);
    out = redact_pangolin_headers(&out);
    out = redact_sensitive_key_values(&out);
    out = redact_urls_in_text(&out);
    out
}

/// Never panic on the logging hot path — fall back to the raw line if needed.
pub fn sanitize_log_line_infallible(line: &str) -> String {
    std::panic::catch_unwind(|| sanitize_log_line(line)).unwrap_or_else(|_| line.to_string())
}

fn redact_bearer_tokens(line: &str) -> String {
    let marker = "Bearer ";
    let mut s = line.to_string();
    let mut search_from = 0;
    while let Some(rel) = s[search_from..].find(marker) {
        let idx = search_from + rel;
        let start = idx + marker.len();
        let end = s[start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == ']')
            .map(|i| start + i)
            .unwrap_or(s.len());
        if end > start {
            s.replace_range(start..end, "REDACTED");
        }
        search_from = start + "REDACTED".len();
    }
    s
}

fn redact_pangolin_headers(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let mut out = line.to_string();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("x-pangolin-") {
        let idx = search_from + rel;
        let after_prefix = &lower[idx..];
        let Some(sep_rel) = after_prefix.find([':', '=']) else {
            search_from = idx + 1;
            continue;
        };
        let sep_idx = idx + sep_rel;
        let val_start = sep_idx + 1;
        let slice = &out[val_start..];
        let trimmed = slice.trim_start();
        let ws = slice.len().saturating_sub(trimmed.len());
        let val_start = val_start + ws;
        let end = trimmed
            .find(|c: char| c.is_whitespace() || c == '&' || c == ',' || c == ';' || c == ')')
            .unwrap_or(trimmed.len());
        if end > 0 {
            out.replace_range(val_start..val_start + end, "REDACTED");
        }
        search_from = val_start + "REDACTED".len();
        if search_from >= out.len() {
            break;
        }
    }
    out
}

fn redact_sensitive_key_values(line: &str) -> String {
    let mut out = line.to_string();
    for key in SENSITIVE_KV_KEYS {
        for sep in [':', '='] {
            let needle = format!("{key}{sep}");
            let lower = out.to_ascii_lowercase();
            let mut search_from = 0;
            while let Some(rel) = lower[search_from..].find(&needle) {
                let idx = search_from + rel;
                let val_start = idx + needle.len();
                let slice = &out[val_start..];
                let trimmed = slice.trim_start();
                let ws = slice.len().saturating_sub(trimmed.len());
                let val_start = val_start + ws;
                let end = trimmed
                    .find(|c: char| c.is_whitespace() || c == '&' || c == ',' || c == ';' || c == ')')
                    .unwrap_or(trimmed.len());
                if end > 0 {
                    out.replace_range(val_start..val_start + end, "REDACTED");
                }
                search_from = val_start + "REDACTED".len();
                if search_from >= out.len() {
                    break;
                }
            }
        }
    }
    out
}

fn url_char_ends_url(ch: char, s: &str, byte_off: usize) -> bool {
    if ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '>' {
        return true;
    }
    if ch == ')' || ch == ']' || ch == ',' {
        if let Some(next) = s[byte_off..].chars().nth(1) {
            return next.is_whitespace() || next == '"' || next == '\'';
        }
    }
    false
}

fn redact_urls_in_text(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0;
    while cursor < line.len() {
        let slice = &line[cursor..];
        let rel = match (slice.find("http://"), slice.find("https://")) {
            (Some(h), Some(s)) => Some(h.min(s)),
            (Some(h), None) => Some(h),
            (None, Some(s)) => Some(s),
            (None, None) => None,
        };
        let Some(rel) = rel else {
            out.push_str(slice);
            break;
        };
        out.push_str(&slice[..rel]);
        let url_start = cursor + rel;
        let url_slice = &line[url_start..];
        let scheme_len = if url_slice.starts_with("https://") { 8 } else { 7 };
        let mut url_end = scheme_len;
        for (off, ch) in url_slice[scheme_len..].char_indices() {
            let abs = scheme_len + off;
            if url_char_ends_url(ch, url_slice, abs) {
                break;
            }
            url_end = abs + ch.len_utf8();
        }
        out.push_str(&redact_url(&line[url_start..url_start + url_end]));
        cursor = url_start + url_end;
    }
    out
}

fn redact_url(raw: &str) -> String {
    let (url, suffix) = split_trailing_punct(raw);
    let mut out = String::new();

    let scheme_end = url.find("://").map(|i| i + 3).unwrap_or(0);
    out.push_str(&url[..scheme_end]);

    let mut rest = &url[scheme_end..];
    if let Some(at) = rest.rfind('@') {
        // Drop userinfo entirely.
        out.push_str("***@");
        rest = &rest[at + 1..];
    }

    let (hostport, path) = split_host_path(rest);
    let (host, port) = split_host_port(&hostport);
    let masked_host = mask_hostname(&host);
    out.push_str(&masked_host);
    if let Some(p) = port {
        out.push(':');
        out.push_str(&p);
    }
    if let Some((path_only, query)) = path.split_once('?') {
        out.push_str(path_only);
        out.push('?');
        out.push_str(&redact_query_string(query));
    } else {
        out.push_str(&path);
    }

    format!("{out}{suffix}")
}

fn split_trailing_punct(raw: &str) -> (&str, &str) {
    let mut end = raw.len();
    while end > 0 {
        let ch = raw.as_bytes()[end - 1] as char;
        if ch == ')' || ch == ']' || ch == ',' {
            end -= 1;
            continue;
        }
        break;
    }
    (&raw[..end], &raw[end..])
}

fn split_host_path(rest: &str) -> (String, String) {
    if rest.starts_with('[') {
        if let Some(end) = rest.find(']') {
            let hostport = &rest[..=end];
            return (hostport.to_string(), rest[end + 1..].to_string());
        }
    }
    if let Some(slash) = rest.find('/') {
        (rest[..slash].to_string(), rest[slash..].to_string())
    } else {
        (rest.to_string(), String::new())
    }
}

fn split_host_port(hostport: &str) -> (String, Option<String>) {
    if hostport.starts_with('[') {
        if let Some(end) = hostport.find("]:") {
            return (
                hostport[..=end].to_string(),
                Some(hostport[end + 2..].to_string()),
            );
        }
        return (hostport.to_string(), None);
    }
    if let Some((h, p)) = hostport.rsplit_once(':') {
        if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && !h.contains(':') {
            return (h.to_string(), Some(p.to_string()));
        }
    }
    (hostport.to_string(), None)
}

fn redact_query_string(query: &str) -> String {
    query
        .split('&')
        .map(|pair| {
            let (k, _v) = pair.split_once('=').unwrap_or((pair, ""));
            if is_sensitive_query_key(k) {
                format!("{k}=REDACTED")
            } else {
                pair.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn is_sensitive_query_key(key: &str) -> bool {
    let k = key.trim().to_ascii_lowercase();
    SENSITIVE_QUERY_KEYS.iter().any(|needle| *needle == k)
}

fn is_lan_ipv4(ip: &str) -> bool {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let Ok(a) = parts[0].parse::<u8>() else { return false };
    let Ok(b) = parts[1].parse::<u8>() else { return false };
    a == 127
        || a == 10
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
}

fn is_lan_ipv6(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h == "::1" {
        return true;
    }
    if h.starts_with("fe8") || h.starts_with("fe9") || h.starts_with("fea") || h.starts_with("feb") {
        return true;
    }
    if h.starts_with("fc") || h.starts_with("fd") {
        return true;
    }
    if let Some(rest) = h.strip_prefix("::ffff:") {
        if rest.contains('.') {
            return is_lan_ipv4(rest);
        }
        if let Some((a, b)) = rest.split_once(':') {
            if let (Ok(v1), Ok(v2)) = (u16::from_str_radix(a, 16), u16::from_str_radix(b, 16)) {
                let ip = format!(
                    "{}.{}.{}.{}",
                    (v1 >> 8) & 0xff,
                    v1 & 0xff,
                    (v2 >> 8) & 0xff,
                    v2 & 0xff
                );
                return is_lan_ipv4(&ip);
            }
        }
    }
    false
}

fn is_lan_host(host: &str) -> bool {
    let stripped = host.trim().trim_matches(|c| c == '[' || c == ']');
    let lower = stripped.to_ascii_lowercase();
    if lower.is_empty() || lower == "localhost" || lower.ends_with(".local") {
        return true;
    }
    if stripped.contains(':') {
        return is_lan_ipv6(stripped);
    }
    if stripped.chars().all(|c| c.is_ascii_digit() || c == '.') && stripped.matches('.').count() == 3 {
        return is_lan_ipv4(stripped);
    }
    false
}

fn mask_label_prefix(label: &str) -> String {
    let mut chars = label.chars();
    let c1 = chars.next();
    let c2 = chars.next();
    match (c1, c2) {
        (None, _) => "*".to_string(),
        (Some(a), None) => a.to_string(),
        (Some(a), Some(b)) => {
            let rest = label.chars().count().saturating_sub(2);
            let stars = rest.clamp(1, 4);
            format!("{a}{b}{}", "*".repeat(stars))
        }
    }
}

fn mask_public_ipv4(ip: &str) -> String {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return "***".to_string();
    }
    format!("{}.*.*.{}", parts[0], parts[3])
}

fn mask_hostname(host: &str) -> String {
    let stripped = host.trim().trim_matches(|c| c == '[' || c == ']');
    if is_lan_host(stripped) {
        return host.to_string();
    }

    if stripped.chars().all(|c| c.is_ascii_digit() || c == '.') && stripped.matches('.').count() == 3 {
        return mask_public_ipv4(stripped);
    }

    if stripped.contains(':') {
        return "[ipv6-redacted]".to_string();
    }

    let parts: Vec<&str> = stripped.split('.').collect();
    if parts.is_empty() {
        return "***".to_string();
    }

    let masked_first = mask_label_prefix(parts[0]);

    if parts.len() == 1 {
        masked_first
    } else {
        format!("{}.{}", masked_first, parts[1..].join("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_subsonic_wire_auth_params() {
        let line = "GET https://music.example.com/rest/stream.view?id=1&t=abc&s=def&p=ghi";
        let out = sanitize_log_line(line);
        assert!(out.contains("t=REDACTED"));
        assert!(out.contains("s=REDACTED"));
        assert!(out.contains("p=REDACTED"));
        assert!(!out.contains("abc"));
    }

    #[test]
    fn masks_remote_hostname_keeps_lan_ip() {
        let remote = sanitize_log_line("connect https://my-server.example.com:4533/rest/ping");
        assert!(remote.contains("my****.example.com"));
        assert!(!remote.contains("my-server.example.com"));

        let lan = sanitize_log_line("connect http://192.168.1.42:4533/rest/ping");
        assert!(lan.contains("192.168.1.42"));
    }

    #[test]
    fn redacts_bearer_and_password_kv() {
        let line = "auth header Bearer eyJhbGciOiJIUzI1NiJ9.xyz password=sekrit";
        let out = sanitize_log_line(line);
        assert!(out.contains("Bearer REDACTED"));
        assert!(!out.contains("eyJhbGci"));
        assert!(out.contains("password=REDACTED"));
        assert!(!out.contains("sekrit"));
    }

    #[test]
    fn strips_url_userinfo() {
        let line = "fetch https://user:pass@10.0.0.5:4533/rest/ping";
        let out = sanitize_log_line(line);
        assert!(out.contains("***@10.0.0.5"));
        assert!(!out.contains("user:pass"));
    }

    #[test]
    fn redacts_reverse_proxy_gate_headers() {
        let line = "req CF-Access-Client-Secret: gate-secret Authorization: Bearer tok123 x-pangolin-auth: pangolin-key";
        let out = sanitize_log_line(line);
        assert!(out.contains("CF-Access-Client-Secret: REDACTED"));
        assert!(!out.contains("gate-secret"));
        assert!(!out.contains("tok123"));
        assert!(out.contains("x-pangolin-auth: REDACTED"));
        assert!(!out.contains("pangolin-key"));
    }

    #[test]
    fn stream_log_with_em_dash_does_not_panic() {
        let line = "[stream] RangedHttpSource selected — total=15666KB, hint=Some(\"mp3\")";
        let out = sanitize_log_line(line);
        assert!(out.contains('—'));
        assert!(out.contains("RangedHttpSource"));
    }
}
