//! `Number` coercion for SQLite scalar fields, including the non-STRICT schema's
//! TEXT values. JSON.stringify represents non-finite results as null; binding a
//! failed conversion must never fall back to the original text and match a CAS.
use super::AutomationRuntimeReconciliationError as Error;
use serde_json::{Value, json};

fn trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    })
}

// All supported radix prefixes use a power of two. Retain the leading 53 bits,
// round bit and sticky remainder, avoiding repeated intermediate f64 rounding.
fn radix(value: &str, base: u32, width: u32) -> Option<f64> {
    if value.is_empty() {
        return None;
    }
    let mut started = false;
    let mut bits = 0u64;
    let mut leading = 0u64;
    let mut round = false;
    let mut sticky = false;
    for c in value.chars() {
        let digit = c.to_digit(base)?;
        if !c.is_ascii() {
            return None;
        }
        for bit in (0..width).rev() {
            let one = digit & (1 << bit) != 0;
            if !started && !one {
                continue;
            }
            started = true;
            bits = bits.saturating_add(1);
            if bits <= 53 {
                leading = (leading << 1) | u64::from(one);
            } else if bits == 54 {
                round = one;
            } else {
                sticky |= one;
            }
        }
    }
    if bits <= 53 {
        return Some(leading as f64);
    }
    if bits > 1024 {
        return Some(f64::INFINITY);
    }
    if round && (sticky || leading & 1 != 0) {
        leading += 1;
    }
    Some(leading as f64 * 2f64.powi((bits - 53) as i32))
}
fn string_number(value: &str) -> Option<f64> {
    let value = trim(value);
    if value.is_empty() {
        return Some(0.);
    }
    for (lower, upper, base, width) in [("0x", "0X", 16, 4), ("0o", "0O", 8, 3), ("0b", "0B", 2, 1)]
    {
        if let Some(digits) = value
            .strip_prefix(lower)
            .or_else(|| value.strip_prefix(upper))
        {
            return radix(digits, base, width);
        }
    }
    if matches!(value, "Infinity" | "+Infinity") {
        return Some(f64::INFINITY);
    }
    if value == "-Infinity" {
        return Some(f64::NEG_INFINITY);
    }
    static DECIMAL: std::sync::OnceLock<Result<regex::Regex, regex::Error>> =
        std::sync::OnceLock::new();
    let pattern = DECIMAL
        .get_or_init(|| {
            regex::Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
        })
        .as_ref()
        .ok()?;
    if !pattern.is_match(value) {
        return None;
    }
    value.parse().ok()
}
pub(super) fn number(value: &Value) -> Result<Value, Error> {
    let number = match value {
        Value::Null => return Ok(json!(0)),
        Value::Bool(value) => return Ok(json!(i64::from(*value))),
        Value::Number(_) => return Ok(value.clone()),
        Value::String(value) => string_number(value),
        _ => None, // The admitted row reader rejects SQLite BLOBs.
    };
    let Some(number) = number.filter(|number| number.is_finite()) else {
        return Ok(Value::Null);
    };
    // Retain the existing ECMAScript spelling and serde_json parsing path, so
    // integer variants and any floating-point rounding stay wire-compatible.
    serde_json::from_str(ryu_js::Buffer::new().format(number)).map_err(|_| Error::Row)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_scalar_number_coercion_matches_node_including_radix_rounding() {
        let mut values = vec![
            Value::Null,
            json!(true),
            json!(false),
            json!(0),
            json!(-3.5),
        ];
        values.extend(
            [
                "",
                " ",
                "\u{feff}17\u{feff}",
                "\u{85}17",
                "bogus",
                "false",
                "inf",
                "infinity",
                "NaN",
                "Infinity",
                "+Infinity",
                "-Infinity",
                "0x10",
                "-0x10",
                "+0x10",
                "0o77",
                "0b101",
                "0x",
                "0o8",
                "0b2",
                ".5",
                "5.",
                "-0",
                "1e3",
                "1e309",
                "-1e309",
                "1e-324",
                "5e-324",
                "1e-7",
                "1e20",
                "1e21",
                "9007199254740993",
                "9223372036854775807",
                "18446744073709551615",
                "2.2250738585072014e-308",
                "2.2250738585072012e-308",
                "0.84551240822557006",
                "1.2345678901234567",
                "9.999999999999999e22",
                "1.0000000000000002",
                "1_000",
                "0x1000000000000081",
                "0x100000000000007f",
                "0x1000000000000080",
                "0x1000000000000180",
                "0xffffffffffffffffffffffffffffffff",
            ]
            .map(|s| json!(s)),
        );
        values.push(json!(format!("0b1{}1", "0".repeat(1023))));
        let output = std::process::Command::new("node").args(["--input-type=module","-e",
            "if(process.versions.node!=='22.23.1')throw Error('pinned_node_required');process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(Number)))",
            &serde_json::to_string(&values).unwrap()]).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
        for (input, expected) in values.iter().zip(expected) {
            assert_eq!(number(input).unwrap(), expected, "input={input}");
        }
    }
}
