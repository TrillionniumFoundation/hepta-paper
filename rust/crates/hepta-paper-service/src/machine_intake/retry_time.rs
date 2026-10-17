//! A bounded subset of the retry timestamps accepted by Node's `Date.parse`.
//!
//! This is a validity check, not a timestamp conversion. In particular, a value
//! without a zone may denote local time to Node even if SQLite emitted it from
//! a UTC clock. The repository continues to compare the original strings in SQL.

use super::contract::canonical_instant;
use serde_json::Value;

const MAXIMUM_RETRY_TIME_BYTES: usize = 128;

/// Accept canonical instants and common full-second ISO/SQLite date strings.
/// Four-digit years support optional fractional seconds and an optional zone:
/// `Z`, `+/-HH:MM`, or `+/-HHMM`. Expanded years retain only the existing canonical
/// form. Locale strings, date-only inputs, rollover dates and `24:00` are outside
/// this deliberately smaller contract, even where Node normalizes them.
pub(super) fn supported_retry_time(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    if text.len() > MAXIMUM_RETRY_TIME_BYTES || !text.is_ascii() {
        return false;
    }
    if canonical_instant(value).is_some() {
        return true;
    }
    if text.len() < 19 || !matches!(text.as_bytes()[10], b'T' | b't' | b' ') {
        return false;
    }

    let tail = &text[19..];
    let (fraction, zone) = if let Some(fraction_and_zone) = tail.strip_prefix('.') {
        let length = fraction_and_zone
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if length == 0 {
            return false;
        }
        fraction_and_zone.split_at(length)
    } else {
        ("", tail)
    };
    if !supported_zone(zone) {
        return false;
    }

    // Date.parse ignores fractional digits beyond milliseconds. Padding and
    // truncation here only lets the existing Gregorian validator check the
    // calendar/time fields; it does not replace the persisted value.
    let mut millis = fraction.chars().take(3).collect::<String>();
    while millis.len() < 3 {
        millis.push('0');
    }
    let core = format!("{}T{}.{}Z", &text[..10], &text[11..19], millis);
    canonical_instant(&Value::String(core)).is_some()
}

fn supported_zone(zone: &str) -> bool {
    if matches!(zone, "" | "Z" | "z") {
        return true;
    }
    let bytes = zone.as_bytes();
    if !matches!(bytes.first(), Some(b'+' | b'-')) {
        return false;
    }
    let (hour, minute) = match bytes {
        [_, h1, h2, m1, m2] => ([*h1, *h2], [*m1, *m2]),
        [_, h1, h2, b':', m1, m2] => ([*h1, *h2], [*m1, *m2]),
        _ => return false,
    };
    if !hour.iter().chain(&minute).all(u8::is_ascii_digit) {
        return false;
    }
    let number = |pair: [u8; 2]| (pair[0] - b'0') * 10 + pair[1] - b'0';
    number(hour) <= 23 && number(minute) <= 59
}

#[cfg(test)]
mod tests {
    use super::{MAXIMUM_RETRY_TIME_BYTES, supported_retry_time};
    use serde_json::{Value, json};

    #[test]
    fn accepts_common_node_and_sqlite_persisted_formats_without_conversion() {
        for text in [
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00.1Z",
            "2026-01-01T00:00:00.12Z",
            "2026-01-01T00:00:00.123Z",
            "2026-01-01T00:00:00.123456789Z",
            "2026-01-01T01:00:00+01:00",
            "2026-01-01T01:00:00+0100",
            "2026-01-01T00:00:00-23:59",
            "2026-01-01T00:00:00+2359",
            "2026-01-01T00:00:00-00:00",
            "2026-01-01t00:00:00z",
            "2026-01-01 00:00:00",
            "2026-01-01 00:00:00.123",
            "2026-01-01 00:00:00Z",
            "2026-01-01 00:00:00.1+01:00",
            "2026-01-01T00:00:00",
            "0000-01-01T00:00:00Z",
            "9999-12-31T23:59:59-2359",
            "2024-02-29T00:00:00Z",
            "+010000-01-01T00:00:00.000Z",
            "-000001-01-01T00:00:00.000Z",
        ] {
            let value = json!(text);
            assert!(supported_retry_time(&value), "{text}");
            assert_eq!(value.as_str(), Some(text));
        }
    }

    #[test]
    fn rejects_invalid_calendar_zone_and_unported_date_parse_inputs() {
        for text in [
            "",
            "2026-01-01T00:00:60Z",
            "2026-02-29T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-01-00T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:60:00Z",
            "2026-01-01T00:00:00.Z",
            "2026-01-01T00:00:00.1.2Z",
            "2026-01-01T00:00:00+24:00",
            "2026-01-01T00:00:00+01:60",
            "2026-01-01T00:00:00+01",
            "2026-01-01T00:00:00++1:00",
            "2026-01-01T00:00:00+0a00",
            "2026-01-01T00:00:00Zjunk",
            "2026-01-01T00:00:00Z\n",
            " 2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00\0",
            "2026-01-01T00:00:00.１２Z",
            "-000000-01-01T00:00:00.000Z",
            "+010000-01-01T00:00:00Z",
            "2026-01-01",
            "January 1, 2026 00:00:00 GMT",
            "2026/01/01 00:00:00",
        ] {
            assert!(!supported_retry_time(&json!(text)), "{text}");
        }
        for value in [Value::Null, json!(0), json!(true), json!([]), json!({})] {
            assert!(!supported_retry_time(&value));
        }
    }

    #[test]
    fn bounds_fractional_input_bytes() {
        let prefix = "2026-01-01T00:00:00.";
        let boundary = format!(
            "{prefix}{}Z",
            "1".repeat(MAXIMUM_RETRY_TIME_BYTES - prefix.len() - 1)
        );
        assert_eq!(boundary.len(), MAXIMUM_RETRY_TIME_BYTES);
        assert!(supported_retry_time(&json!(boundary)));
        let excessive = format!(
            "{prefix}{}Z",
            "1".repeat(MAXIMUM_RETRY_TIME_BYTES - prefix.len())
        );
        assert_eq!(excessive.len(), MAXIMUM_RETRY_TIME_BYTES + 1);
        assert!(!supported_retry_time(&json!(excessive)));
    }
}
