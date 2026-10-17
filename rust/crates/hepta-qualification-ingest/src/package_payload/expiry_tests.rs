//! Decimal conversion boundaries only. Genuine signed factory coverage lives in
//! the CLI's joint_closure tests; these parsed timestamps grant no authority.

use super::*;
use serde_json::json;

const BASE: u64 = 1_788_091_200_000;

fn assert_first_invalid_sample(expires: &str, expected: u64) {
    let parsed = parse_utc_timestamp(expires).expect("valid exact UTC timestamp");
    assert_eq!(
        first_invalid_unix_ms(&parsed).expect("bounded expiry"),
        expected
    );
    let window = json!({
        "issuedAt": "2026-08-30T11:59:59Z",
        "expiresAt": expires,
    });
    let window = window.as_object().expect("window object");
    assert!(
        current_time_window(window, expected - 1).is_ok(),
        "{expires}"
    );
    for now in [expected, expected + 1] {
        assert!(
            matches!(
                current_time_window(window, now),
                Err(QualificationPayloadError::SemanticInvalid)
            ),
            "{expires} at {now}"
        );
    }
}

#[test]
fn exclusive_millisecond_ceiling_matches_exact_decimal_window_comparisons() {
    for (fraction, offset) in [
        ("", 0),
        (".0000", 0),
        (".1", 100),
        (".10", 100),
        (".100", 100),
        (".1000", 100),
        (".1005", 101),
        (".0000001", 1),
        (".999", 999),
        (".999000", 999),
        (".999999", 1_000),
    ] {
        assert_first_invalid_sample(&format!("2026-08-30T12:00:00{fraction}Z"), BASE + offset);
    }
    // Precision is not limited to nanoseconds or a floating-point mantissa.
    let long_fraction = format!(".100{}1", "0".repeat(256));
    assert_first_invalid_sample(&format!("2026-08-30T12:00:00{long_fraction}Z"), BASE + 101);
    assert_first_invalid_sample("2026-08-30T12:00:01Z", BASE + 1_000);
}

#[test]
fn parsed_epoch_and_maximum_calendar_year_preserve_exact_bounds() {
    for (text, expected) in [
        ("1970-01-01T00:00:00Z", 0),
        ("1970-01-01T00:00:00.0001Z", 1),
        ("1970-01-01T00:00:00.0010Z", 1),
        ("9999-12-31T23:59:59.999999Z", 253_402_300_800_000),
    ] {
        let parsed = parse_utc_timestamp(text).expect("supported calendar timestamp");
        assert_eq!(
            first_invalid_unix_ms(&parsed).expect("representable boundary"),
            expected
        );
    }
    let negative = parse_utc_timestamp("1969-12-31T23:59:59.999999Z")
        .expect("syntactically supported pre-epoch date");
    assert!(matches!(
        first_invalid_unix_ms(&negative),
        Err(QualificationPayloadError::SemanticInvalid)
    ));
}

#[test]
fn private_conversion_checks_multiplication_addition_and_rounding_overflow() {
    // These synthetic internal seconds exceed the public parser's year bound.
    // They test checked arithmetic only, not acceptance of a signed document.
    let multiplication_overflow = ParsedUtcTimestamp {
        epoch_seconds: i64::MAX,
        fraction: Vec::new(),
    };
    assert!(matches!(
        first_invalid_unix_ms(&multiplication_overflow),
        Err(QualificationPayloadError::SemanticInvalid)
    ));
    let largest_seconds = i64::try_from(u64::MAX / 1_000).expect("seconds fit i64");
    let exact = ParsedUtcTimestamp {
        epoch_seconds: largest_seconds,
        fraction: b"6150".to_vec(),
    };
    assert_eq!(
        first_invalid_unix_ms(&exact).expect("exact u64 limit"),
        u64::MAX
    );
    for fraction in [b"6151".as_slice(), b"616".as_slice()] {
        let overflow = ParsedUtcTimestamp {
            epoch_seconds: largest_seconds,
            fraction: fraction.to_vec(),
        };
        assert!(matches!(
            first_invalid_unix_ms(&overflow),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }
}
