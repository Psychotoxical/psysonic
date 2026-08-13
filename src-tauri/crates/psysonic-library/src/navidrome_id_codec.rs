//! Canonical Navidrome entity and structured-artwork ID codec.

/// Exact port of Navidrome's uniform canonical-ID migration helper.
pub fn canonical_id(value: &str) -> String {
    let bytes = match value.len() {
        22 => match decode_base62_u128(value) {
            Ok(_) => return value.to_string(),
            Err(Base62Error::Overflow) => md5::compute(value.as_bytes()).0,
            Err(Base62Error::Invalid) => return value.to_string(),
        },
        32 => match decode_hex_16(value) {
            Some(bytes) => bytes,
            None => return value.to_string(),
        },
        36 => {
            if value.as_bytes().get(8) != Some(&b'-')
                || value.as_bytes().get(13) != Some(&b'-')
                || value.as_bytes().get(18) != Some(&b'-')
                || value.as_bytes().get(23) != Some(&b'-')
            {
                return value.to_string();
            }
            let compact = value.chars().filter(|character| *character != '-').collect::<String>();
            match decode_hex_16(&compact) {
                Some(bytes) => bytes,
                None => return value.to_string(),
            }
        }
        _ => return value.to_string(),
    };
    encode_base62(bytes)
}

/// Rewrite only the entity-bearing payload of a Navidrome artwork ID.
pub fn canonical_artwork_id(value: &str) -> String {
    let Some((prefix, payload)) = ["mf-", "al-", "ar-", "pl-", "dc-", "ra-"]
        .into_iter()
        .find_map(|prefix| value.strip_prefix(prefix).map(|payload| (prefix, payload)))
    else {
        return canonical_id(value);
    };

    let (payload, update_token) = split_update_token(payload);
    let rewritten = if prefix == "dc-" {
        match payload.split_once(':') {
            Some((album_id, disc_number)) => {
                format!("{}:{disc_number}", canonical_id(album_id))
            }
            None => payload.to_string(),
        }
    } else {
        canonical_id(payload)
    };
    match update_token {
        Some(token) => format!("{prefix}{rewritten}_{token}"),
        None => format!("{prefix}{rewritten}"),
    }
}

fn split_update_token(value: &str) -> (&str, Option<&str>) {
    let Some((payload, token)) = value.rsplit_once('_') else {
        return (value, None);
    };
    if !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        (payload, Some(token))
    } else {
        (value, None)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base62Error {
    Invalid,
    Overflow,
}

fn decode_base62_u128(value: &str) -> Result<u128, Base62Error> {
    let mut out = 0u128;
    for byte in value.bytes() {
        let digit = match byte {
            b'0'..=b'9' => (byte - b'0') as u128,
            b'a'..=b'z' => (byte - b'a' + 10) as u128,
            b'A'..=b'Z' => (byte - b'A' + 36) as u128,
            _ => return Err(Base62Error::Invalid),
        };
        out = out
            .checked_mul(62)
            .and_then(|current| current.checked_add(digit))
            .ok_or(Base62Error::Overflow)?;
    }
    Ok(out)
}

fn decode_hex_16(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (index, slot) in out.iter_mut().enumerate() {
        let high = hex_digit(value.as_bytes()[index * 2])?;
        let low = hex_digit(value.as_bytes()[index * 2 + 1])?;
        *slot = (high << 4) | low;
    }
    Some(out)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn encode_base62(bytes: [u8; 16]) -> String {
    const DIGITS: &[u8; 62] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut value = u128::from_be_bytes(bytes);
    let mut encoded = [b'0'; 22];
    let mut index = encoded.len();
    while value > 0 {
        index -= 1;
        encoded[index] = DIGITS[(value % 62) as usize];
        value /= 62;
    }
    String::from_utf8(encoded.to_vec()).expect("base62 alphabet is UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_upstream_vectors() {
        for (input, expected) in [
            ("5cLJPkLA5DK2BADhoeotPk", "5cLJPkLA5DK2BADhoeotPk"),
            ("zzzzzzzzzzzzzzzzzzzzzz", "3LyqmwQBm5IRqlVjNYASwb"),
            ("e3b7fc2ae9447bbec37a13bf916e3cf6", "6VHl3uR4kss6sUPKA8Cwnk"),
            ("f47ac10b-58cc-4372-a567-0e02b2c3d479", "7rke2SAWaicSeSYzkhww6R"),
        ] {
            assert_eq!(canonical_id(input), expected);
        }
    }

    #[test]
    fn rewrites_structured_artwork_without_losing_suffixes() {
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = "6VHl3uR4kss6sUPKA8Cwnk";
        for prefix in ["mf-", "al-", "ar-", "pl-", "ra-"] {
            assert_eq!(canonical_artwork_id(&format!("{prefix}{old}")), format!("{prefix}{new}"));
            assert_eq!(
                canonical_artwork_id(&format!("{prefix}{old}_60fc987f")),
                format!("{prefix}{new}_60fc987f")
            );
        }
        assert_eq!(
            canonical_artwork_id(&format!("dc-{old}:2_60fc987f")),
            format!("dc-{new}:2_60fc987f")
        );
    }
}
