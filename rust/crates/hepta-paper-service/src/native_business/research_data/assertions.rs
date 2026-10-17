use super::{
    NativeBusinessError, check_cancel, validate_value,
    values::{self, field, object, text},
};
use hepta_legacy_compatibility::{
    ProductionJsonEncodedResourcesV1, ProductionJsonEncodingLimitsV1, ProductionJsonValue as V,
    parse_production_json_v1, production_json_resources_v1,
    production_json_stringify_with_limits_v1,
};
use std::sync::atomic::AtomicBool;

pub(super) fn limits() -> ProductionJsonEncodingLimitsV1 {
    ProductionJsonEncodingLimitsV1 {
        maximum_bytes: super::MAX_INPUT_BYTES as usize,
        maximum_values: super::MAX_NODES,
        maximum_utf16_units: super::MAX_INPUT_BYTES as usize,
    }
}
fn remaining(
    used: &ProductionJsonEncodedResourcesV1,
) -> Result<ProductionJsonEncodingLimitsV1, NativeBusinessError> {
    let maximum = limits();
    Ok(ProductionJsonEncodingLimitsV1 {
        maximum_bytes: maximum
            .maximum_bytes
            .checked_sub(used.bytes)
            .ok_or(NativeBusinessError::OutputLimit)?,
        maximum_values: maximum
            .maximum_values
            .checked_sub(used.values)
            .ok_or(NativeBusinessError::OutputLimit)?,
        maximum_utf16_units: maximum
            .maximum_utf16_units
            .checked_sub(used.utf16_units)
            .ok_or(NativeBusinessError::OutputLimit)?,
    })
}
fn include(
    value: &V,
    used: &mut ProductionJsonEncodedResourcesV1,
    cancelled: &AtomicBool,
) -> Result<(), NativeBusinessError> {
    let measured = production_json_resources_v1(value, remaining(used)?, cancelled)
        .map_err(|_| NativeBusinessError::OutputLimit)?;
    used.bytes += measured.bytes;
    used.values += measured.values;
    used.utf16_units += measured.utf16_units;
    Ok(())
}
enum Lookup<'a> {
    Borrowed(&'a V),
    Scalar(V),
}
impl Lookup<'_> {
    fn value(&self) -> &V {
        match self {
            Self::Borrowed(value) => value,
            Self::Scalar(value) => value,
        }
    }
}
struct AssertionResult<'a> {
    path: Vec<u16>,
    op: Vec<u16>,
    expected: Option<&'a V>,
    actual: Option<Lookup<'a>>,
    passed: bool,
}
fn passed(
    op: Option<&V>,
    actual: Option<&V>,
    expected: Option<&V>,
    cancelled: &AtomicBool,
) -> Result<bool, NativeBusinessError> {
    Ok(match op {
        Some(V::String(units)) if units == &"exists".encode_utf16().collect::<Vec<_>>() => {
            actual.is_some()
        }
        Some(V::String(units)) if units == &"equals".encode_utf16().collect::<Vec<_>>() => {
            stringify(actual, cancelled)? == stringify(expected, cancelled)?
        }
        Some(V::String(units)) if units == &"gte".encode_utf16().collect::<Vec<_>>() => {
            let actual = values::number_coercion(actual)?;
            actual.is_finite() && actual >= values::number_coercion(expected)?
        }
        Some(V::String(units)) if units == &"lte".encode_utf16().collect::<Vec<_>>() => {
            let actual = values::number_coercion(actual)?;
            actual.is_finite() && actual <= values::number_coercion(expected)?
        }
        Some(V::String(units)) if units == &"truthy".encode_utf16().collect::<Vec<_>>() => {
            values::truthy(actual)
        }
        _ => false,
    })
}
fn measure_result(
    row: &AssertionResult<'_>,
    used: &mut ProductionJsonEncodedResourcesV1,
    cancelled: &AtomicBool,
) -> Result<(), NativeBusinessError> {
    // Only parameter-sized metadata is materialized. Both document subtrees
    // remain borrowed until the complete report budget has been proven.
    let skeleton = object([
        ("path", V::String(row.path.clone())),
        ("op", V::String(row.op.clone())),
        ("expected", V::Null),
        ("actual", V::Null),
        ("passed", V::Bool(row.passed)),
    ]);
    let mut measured = production_json_resources_v1(&skeleton, limits(), cancelled)
        .map_err(|_| NativeBusinessError::OutputLimit)?;
    measured.bytes -= 8;
    measured.values -= 2; // Two null leaves replaced below.
    used.bytes = used
        .bytes
        .checked_add(measured.bytes)
        .ok_or(NativeBusinessError::OutputLimit)?;
    used.values = used
        .values
        .checked_add(measured.values)
        .ok_or(NativeBusinessError::OutputLimit)?;
    used.utf16_units = used
        .utf16_units
        .checked_add(measured.utf16_units)
        .ok_or(NativeBusinessError::OutputLimit)?;
    remaining(used)?;
    include(row.expected.unwrap_or(&V::Null), used, cancelled)?;
    include(
        row.actual.as_ref().map(Lookup::value).unwrap_or(&V::Null),
        used,
        cancelled,
    )
}
pub(super) fn inspect(
    parameters: &V,
    inputs: &[Vec<u8>],
    cancelled: &AtomicBool,
) -> Result<V, NativeBusinessError> {
    if inputs.len() != 1 {
        return Ok(values::blocked(
            "json_assertion_worker_requires_exactly_one_input",
        ));
    }
    let source = String::from_utf8_lossy(&inputs[0]);
    let document =
        parse_production_json_v1(source.as_bytes()).map_err(|_| NativeBusinessError::Encoding)?;
    validate_value(&document)?;
    check_cancel(cancelled)?;
    let assertions = match field(parameters, "assertions") {
        Some(V::Array(values)) => values.as_slice(),
        _ => &[],
    };
    if assertions.is_empty() {
        return Ok(values::blocked("json_assertions_missing"));
    }
    if assertions.len() > 256 {
        return Err(NativeBusinessError::Contract);
    }
    let mut rows = Vec::new();
    let mut blockers = Vec::new();
    let mut count = 0;
    let mut used = ProductionJsonEncodedResourcesV1::default();
    for assertion in assertions {
        check_cancel(cancelled)?;
        if matches!(assertion, V::Null) {
            return Err(NativeBusinessError::Contract);
        }
        let path = field(assertion, "path");
        let path = if values::truthy(path) {
            values::string(path)?
        } else {
            Vec::new()
        };
        let op = field(assertion, "op");
        let op_text = if values::truthy(op) {
            values::string(op)?
        } else {
            Vec::new()
        };
        let expected = field(assertion, "value");
        let actual = lookup(&document, &path)?;
        let result = passed(op, actual.as_ref().map(Lookup::value), expected, cancelled)?;
        let row = AssertionResult {
            path,
            op: op_text,
            expected,
            actual,
            passed: result,
        };
        if !rows.is_empty() {
            used.bytes += 1;
        }
        measure_result(&row, &mut used, cancelled)?;
        if result {
            count += 1;
        } else {
            let mut blocker: Vec<_> = "json_assertion_failed:".encode_utf16().collect();
            blocker.extend(&row.path);
            if !blockers.is_empty() {
                used.bytes += 1;
            }
            let blocker = V::String(blocker);
            include(&blocker, &mut used, cancelled)?;
            blockers.push(blocker);
        }
        rows.push(row);
    }
    let skeleton = object([
        (
            "status",
            text(if blockers.is_empty() {
                "native_research_worker_passed"
            } else {
                "native_research_worker_blocked"
            }),
        ),
        ("assertionCount", V::Number(rows.len() as f64)),
        ("passedAssertionCount", V::Number(count as f64)),
        ("assertions", V::Array(Vec::new())),
        ("blockers", V::Array(Vec::new())),
    ]);
    include(&skeleton, &mut used, cancelled)?;
    let mut results = Vec::new();
    for row in rows {
        check_cancel(cancelled)?;
        results.push(object([
            ("path", V::String(row.path)),
            ("op", V::String(row.op)),
            ("expected", row.expected.cloned().unwrap_or(V::Null)),
            (
                "actual",
                row.actual
                    .as_ref()
                    .map(Lookup::value)
                    .cloned()
                    .unwrap_or(V::Null),
            ),
            ("passed", V::Bool(row.passed)),
        ]));
        check_cancel(cancelled)?;
    }
    let V::Object(mut fields) = skeleton else {
        return Err(NativeBusinessError::Contract);
    };
    for (key, value) in &mut fields {
        if key.iter().copied().eq("assertions".encode_utf16()) {
            *value = V::Array(std::mem::take(&mut results));
        }
        if key.iter().copied().eq("blockers".encode_utf16()) {
            *value = V::Array(std::mem::take(&mut blockers));
        }
    }
    Ok(V::Object(fields))
}
fn stringify(
    value: Option<&V>,
    cancelled: &AtomicBool,
) -> Result<Option<Vec<u8>>, NativeBusinessError> {
    value
        .map(|v| production_json_stringify_with_limits_v1(v, limits(), cancelled))
        .transpose()
        .map_err(|_| NativeBusinessError::Encoding)
}
fn lookup<'a>(document: &'a V, path: &[u16]) -> Result<Option<Lookup<'a>>, NativeBusinessError> {
    let path = if path.first() == Some(&u16::from(b'$')) {
        if path.get(1) == Some(&u16::from(b'.')) {
            &path[2..]
        } else {
            &path[1..]
        }
    } else {
        path
    };
    let mut current = document;
    let mut parts = path
        .split(|unit| *unit == u16::from(b'.'))
        .filter(|part| !part.is_empty())
        .peekable();
    while let Some(part) = parts.next() {
        let child = match current {
            V::Object(fields) => fields
                .iter()
                .find(|(key, _)| key == part)
                .map(|(_, value)| value),
            V::Array(values) => {
                if part.iter().copied().eq("length".encode_utf16()) {
                    if let Some(next) = parts.peek() {
                        if inherited(next) {
                            return Err(NativeBusinessError::Contract);
                        }
                        return Ok(None);
                    }
                    return Ok(Some(Lookup::Scalar(V::Number(values.len() as f64))));
                }
                let key = String::from_utf16(part).ok();
                key.and_then(|key| {
                    key.parse::<usize>()
                        .ok()
                        .filter(|index| index.to_string() == key)
                })
                .and_then(|index| values.get(index))
            }
            _ => None,
        };
        match child {
            Some(value) => current = value,
            None if inherited(part) => return Err(NativeBusinessError::Contract),
            None => return Ok(None),
        }
    }
    Ok(Some(Lookup::Borrowed(current)))
}
fn inherited(part: &[u16]) -> bool {
    [
        "__proto__",
        "constructor",
        "toString",
        "toLocaleString",
        "valueOf",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
        "at",
        "concat",
        "copyWithin",
        "fill",
        "find",
        "findIndex",
        "findLast",
        "findLastIndex",
        "lastIndexOf",
        "pop",
        "push",
        "reverse",
        "shift",
        "unshift",
        "slice",
        "sort",
        "splice",
        "includes",
        "indexOf",
        "join",
        "keys",
        "entries",
        "values",
        "forEach",
        "filter",
        "flat",
        "flatMap",
        "map",
        "every",
        "some",
        "reduce",
        "reduceRight",
        "toReversed",
        "toSorted",
        "toSpliced",
        "with",
    ]
    .iter()
    .any(|name| name.encode_utf16().eq(part.iter().copied()))
}
