//! Deterministic Navidrome entity and structured-artwork ID codec.

const BASE62_DIGITS: &[u8; 62] =
    b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ARTWORK_PREFIXES: [&str; 7] = ["mf-", "al-", "ar-", "pl-", "ra-", "tr-", "dc-"];

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
        36 => match decode_uuid(value) {
            Some(bytes) => bytes,
            None => return value.to_string(),
        },
        _ => return value.to_string(),
    };
    encode_base62(bytes)
}

pub fn canonical_artwork_id(value: &str) -> String {
    let Some((prefix, payload)) = ARTWORK_PREFIXES
        .into_iter()
        .find_map(|prefix| value.strip_prefix(prefix).map(|payload| (prefix, payload)))
    else {
        return canonical_id(value);
    };
    let (payload, update_token) = split_update_token(payload);
    let rewritten = if prefix == "dc-" {
        match payload.split_once(':') {
            Some((album_id, disc_suffix)) => {
                format!("{}:{disc_suffix}", canonical_id(album_id))
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

pub fn is_lossless_legacy_id(value: &str) -> bool {
    match value.len() {
        32 => decode_hex_16(value).is_some(),
        36 => decode_uuid(value).is_some(),
        _ => false,
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
    let mut decoded = 0u128;
    for byte in value.bytes() {
        let digit = match byte {
            b'0'..=b'9' => (byte - b'0') as u128,
            b'a'..=b'z' => (byte - b'a' + 10) as u128,
            b'A'..=b'Z' => (byte - b'A' + 36) as u128,
            _ => return Err(Base62Error::Invalid),
        };
        decoded = decoded
            .checked_mul(62)
            .and_then(|current| current.checked_add(digit))
            .ok_or(Base62Error::Overflow)?;
    }
    Ok(decoded)
}

fn decode_uuid(value: &str) -> Option<[u8; 16]> {
    let bytes = value.as_bytes();
    if bytes.get(8) != Some(&b'-')
        || bytes.get(13) != Some(&b'-')
        || bytes.get(18) != Some(&b'-')
        || bytes.get(23) != Some(&b'-')
    {
        return None;
    }
    let compact = value
        .chars()
        .filter(|character| *character != '-')
        .collect::<String>();
    decode_hex_16(&compact)
}

fn decode_hex_16(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32 {
        return None;
    }
    let mut decoded = [0u8; 16];
    for (index, slot) in decoded.iter_mut().enumerate() {
        let high = hex_digit(value.as_bytes()[index * 2])?;
        let low = hex_digit(value.as_bytes()[index * 2 + 1])?;
        *slot = (high << 4) | low;
    }
    Some(decoded)
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
    let mut value = u128::from_be_bytes(bytes);
    let mut encoded = [b'0'; 22];
    let mut index = encoded.len();
    while value > 0 {
        index -= 1;
        encoded[index] = BASE62_DIGITS[(value % 62) as usize];
        value /= 62;
    }
    String::from_utf8(encoded.to_vec()).expect("base62 alphabet is valid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY_HEX: &str = "e3b7fc2ae9447bbec37a13bf916e3cf6";
    const CANONICAL_HEX: &str = "6VHl3uR4kss6sUPKA8Cwnk";
    const LEGACY_UUID: &str = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const CANONICAL_UUID: &str = "7rke2SAWaicSeSYzkhww6R";

    #[test]
    fn canonicalizes_legacy_entity_forms() {
        assert_eq!(canonical_id(LEGACY_HEX), CANONICAL_HEX);
        assert_eq!(canonical_id(LEGACY_UUID), CANONICAL_UUID);
        assert_eq!(canonical_id(CANONICAL_HEX), CANONICAL_HEX);
    }

    #[test]
    fn codec_is_idempotent_and_classifies_lossless_forms() {
        for value in [LEGACY_HEX, LEGACY_UUID, "zzzzzzzzzzzzzzzzzzzzzz"] {
            let once = canonical_id(value);
            assert_eq!(canonical_id(&once), once);
        }
        assert!(is_lossless_legacy_id(LEGACY_HEX));
        assert!(is_lossless_legacy_id(LEGACY_UUID));
        assert!(!is_lossless_legacy_id(CANONICAL_HEX));
    }

    #[test]
    fn canonicalizes_structured_artwork() {
        assert_eq!(
            canonical_artwork_id(&format!("tr-{LEGACY_HEX}")),
            format!("tr-{CANONICAL_HEX}")
        );
        assert_eq!(
            canonical_artwork_id(&format!("dc-{LEGACY_HEX}:2_60fc987f")),
            format!("dc-{CANONICAL_HEX}:2_60fc987f")
        );
    }
}
