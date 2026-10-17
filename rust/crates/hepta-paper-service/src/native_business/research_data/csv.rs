use super::{
    NativeBusinessError, check_cancel,
    values::{self, field, object, text},
};
use hepta_legacy_compatibility::ProductionJsonValue as V;
use std::sync::atomic::AtomicBool;

const MAX_ROWS: usize = 65_536;
const MAX_COLUMNS: usize = 256;
const MAX_CELLS: usize = 100_000;
const MAX_CELL_BYTES: usize = 64 * 1024;

pub(super) fn inspect(
    parameters: &V,
    inputs: &[Vec<u8>],
    cancelled: &AtomicBool,
) -> Result<V, NativeBusinessError> {
    if inputs.len() != 1 {
        return Ok(values::blocked("csv_worker_requires_exactly_one_input"));
    }
    let contents = String::from_utf8_lossy(&inputs[0]);
    let mut lines = contents
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !trim(line).is_empty());
    let Some(first) = lines.next() else {
        return Ok(values::blocked("csv_data_rows_missing"));
    };
    let headers = parse_line(first)?;
    let mut rows = Vec::new();
    let mut cells = headers.len();
    for line in lines {
        check_cancel(cancelled)?;
        if rows.len() >= MAX_ROWS {
            return Err(NativeBusinessError::Contract);
        }
        let row = parse_line(line)?;
        cells = cells
            .checked_add(row.len())
            .ok_or(NativeBusinessError::Contract)?;
        if cells > MAX_CELLS {
            return Err(NativeBusinessError::Contract);
        }
        rows.push(row);
    }
    if rows.is_empty() {
        return Ok(values::blocked("csv_data_rows_missing"));
    }
    let requested = match field(parameters, "numericColumns") {
        Some(V::Array(values)) if values.len() <= MAX_COLUMNS => values
            .iter()
            .map(|value| values::string(Some(value)))
            .collect::<Result<Vec<_>, _>>()?,
        Some(V::Array(_)) => return Err(NativeBusinessError::Contract),
        _ => headers
            .iter()
            .map(|value| value.encode_utf16().collect())
            .collect(),
    };
    let mut blockers = Vec::new();
    let mut columns: Vec<(Vec<u16>, V)> = Vec::new();
    for name in requested {
        check_cancel(cancelled)?;
        let Some(index) = headers
            .iter()
            .position(|header| header.encode_utf16().eq(name.iter().copied()))
        else {
            let mut blocker = "csv_numeric_column_missing:"
                .encode_utf16()
                .collect::<Vec<_>>();
            blocker.extend(&name);
            blockers.push(V::String(blocker));
            continue;
        };
        if name == "__proto__".encode_utf16().collect::<Vec<_>>() {
            // The original assigns into an ordinary JS object and mutates its prototype.
            // v1 retains only ordinary own-property column names.
            return Err(NativeBusinessError::Contract);
        }
        let mut numbers = Vec::new();
        for row in &rows {
            check_cancel(cancelled)?;
            if let Some(cell) = row.get(index).filter(|cell| !cell.is_empty())
                && let Some(number) =
                    crate::automation_runtime_reconciliation::sqlite_number::string_number(cell)
                        .filter(|number| number.is_finite())
            {
                numbers.push(number);
            }
        }
        if numbers.len() != rows.len() {
            let mut blocker = "csv_numeric_column_contains_non_numeric_value:"
                .encode_utf16()
                .collect::<Vec<_>>();
            blocker.extend(&name);
            blockers.push(V::String(blocker));
        }
        let stats = statistics(&numbers);
        if let Some((_, value)) = columns.iter_mut().find(|(key, _)| *key == name) {
            *value = stats;
        } else {
            columns.push((name, stats));
        }
    }
    Ok(object([
        (
            "status",
            text(if blockers.is_empty() {
                "native_research_worker_passed"
            } else {
                "native_research_worker_blocked"
            }),
        ),
        ("rowCount", V::Number(rows.len() as f64)),
        ("columns", V::Object(columns)),
        ("blockers", V::Array(blockers)),
    ]))
}
fn trim(value: &str) -> &str {
    crate::automation_runtime_reconciliation::sqlite_number::trim(value)
}
fn parse_line(line: &str) -> Result<Vec<String>, NativeBusinessError> {
    let mut values = Vec::new();
    let mut value = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '"' && quoted && chars.peek() == Some(&'"') {
            value.push('"');
            chars.next();
        } else if character == '"' {
            quoted = !quoted;
        } else if character == ',' && !quoted {
            values.push(trim(&value).to_owned());
            value.clear();
        } else {
            value.push(character);
        }
        if values.len() >= MAX_COLUMNS || value.len() > MAX_CELL_BYTES {
            return Err(NativeBusinessError::Contract);
        }
    }
    values.push(trim(&value).to_owned());
    Ok(values)
}
fn statistics(values: &[f64]) -> V {
    let count = values.len();
    let sum = values.iter().fold(0.0, |total, value| total + value);
    let mean = if count == 0 {
        V::Null
    } else {
        V::Number(sum / count as f64)
    };
    let variance = if count > 1 {
        values.iter().fold(0.0, |total, value| {
            total + (value - sum / count as f64).powi(2)
        }) / (count - 1) as f64
    } else {
        0.0
    };
    object([
        ("count", V::Number(count as f64)),
        (
            "min",
            values
                .iter()
                .copied()
                .reduce(f64::min)
                .map_or(V::Null, V::Number),
        ),
        (
            "max",
            values
                .iter()
                .copied()
                .reduce(f64::max)
                .map_or(V::Null, V::Number),
        ),
        ("sum", V::Number(sum)),
        ("mean", mean),
        ("sampleVariance", V::Number(variance)),
        ("sampleStdDev", V::Number(variance.sqrt())),
    ])
}
