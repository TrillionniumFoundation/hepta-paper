//! Property order is observable in Node's JSON.stringify(rebuilt) comparison.
//! Keep it until the wire contract has been checked, before projecting to Value.

use crate::online_runtime_activation::ordered_json::Json;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct PersonalGpuReceiptWireError;

impl std::fmt::Display for PersonalGpuReceiptWireError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("personal_gpu_existing_receipt_invalid")
    }
}
impl std::error::Error for PersonalGpuReceiptWireError {}

const RECEIPT_ORDER: [&str; 17] = [
    "version",
    "kind",
    "profileId",
    "createdAtEpochMs",
    "workspaceCommit",
    "gpu",
    "runtime",
    "pde",
    "deepLearning",
    "ir",
    "localPolicy",
    "releaseBoundary",
    "personalProductionReady",
    "blockers",
    "externalActionPerformed",
    "networkActionPerformed",
    "personalGpuOperationalReceiptHash",
];
const POLICY_ORDER: [&str; 6] = [
    "version",
    "kind",
    "profileId",
    "scope",
    "secondHardwareStatus",
    "externalAuthorityStatus",
];
const RELEASE_ORDER: [&str; 3] = [
    "independentSecondHardwareRequired",
    "releasePromotionEligible",
    "releaseBlockers",
];

fn ordered(value: Option<&Json>, keys: &[&str]) -> bool {
    matches!(value, Some(Json::Object(entries)) if entries.iter().map(|(key, _)| key.as_str()).eq(keys.iter().copied()))
}

fn parse(bytes: &[u8]) -> Result<(Json, Value), PersonalGpuReceiptWireError> {
    // Buffer.toString('utf8') replaces malformed UTF-8 before JSON.parse.
    let text = String::from_utf8_lossy(bytes);
    let parsed: Json = serde_json::from_str(&text).map_err(|_| PersonalGpuReceiptWireError)?;
    if !ordered(Some(&parsed), &RECEIPT_ORDER)
        || !ordered(parsed.get("localPolicy"), &POLICY_ORDER)
        || !ordered(parsed.get("releaseBoundary"), &RELEASE_ORDER)
    {
        return Err(PersonalGpuReceiptWireError);
    }
    let normalized = parsed
        .stringify()
        .map_err(|_| PersonalGpuReceiptWireError)?;
    let value: Value =
        serde_json::from_str(&normalized).map_err(|_| PersonalGpuReceiptWireError)?;
    if !super::verify_personal_gpu_operational_receipt(&value) {
        return Err(PersonalGpuReceiptWireError);
    }
    Ok((parsed, value))
}

/// Parse and verify both the Node property-order and value/hash contracts.
/// The returned projection has no object-order information; retain the input
/// bytes when emitting the original receipt.
pub fn parse_personal_gpu_operational_receipt_v1(
    bytes: &[u8],
) -> Result<Value, PersonalGpuReceiptWireError> {
    parse(bytes).map(|(_, value)| value)
}

pub fn verify_personal_gpu_operational_receipt_raw_v1(bytes: &[u8]) -> bool {
    parse(bytes).is_ok()
}

fn pretty(value: &Json, depth: usize) -> Result<String, PersonalGpuReceiptWireError> {
    let pad = "  ".repeat(depth);
    let indent = format!("{pad}  ");
    match value {
        Json::Scalar(_) => value.stringify().map_err(|_| PersonalGpuReceiptWireError),
        Json::Array(values) => {
            if values.is_empty() {
                return Ok("[]".into());
            }
            let items = values
                .iter()
                .map(|value| pretty(value, depth + 1).map(|text| format!("{indent}{text}")))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[\n{}\n{pad}]", items.join(",\n")))
        }
        Json::Object(entries) => {
            if entries.is_empty() {
                return Ok("{}".into());
            }
            let index = |key: &str| {
                key.parse::<u32>()
                    .ok()
                    .filter(|n| *n != u32::MAX && n.to_string() == key)
            };
            let mut entries = entries.iter().collect::<Vec<_>>();
            entries.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            });
            let items = entries
                .into_iter()
                .map(|(key, value)| {
                    let key = Json::Scalar(Value::String(key.clone()))
                        .stringify()
                        .map_err(|_| PersonalGpuReceiptWireError)?;
                    Ok(format!("{indent}{key}: {}", pretty(value, depth + 1)?))
                })
                .collect::<Result<Vec<_>, PersonalGpuReceiptWireError>>()?;
            Ok(format!("{{\n{}\n{pad}}}", items.join(",\n")))
        }
    }
}

/// Emit a verified receipt using Node's two-space JSON.stringify layout,
/// retaining nested property order and JavaScript number formatting.
pub fn personal_gpu_receipt_json_v1(bytes: &[u8]) -> Result<String, PersonalGpuReceiptWireError> {
    let (wire, _) = parse(bytes)?;
    pretty(&wire, 0)
}

/// Encode a locally constructed receipt with the builder's fixed field order.
/// Existing wire receipts should use `personal_gpu_receipt_json_v1` instead.
pub fn encode_personal_gpu_operational_receipt_v1(
    value: &Value,
) -> Result<String, PersonalGpuReceiptWireError> {
    fn reorder(value: Json, keys: &[&str]) -> Result<Json, PersonalGpuReceiptWireError> {
        let Json::Object(mut entries) = value else {
            return Err(PersonalGpuReceiptWireError);
        };
        let mut ordered = Vec::new();
        for key in keys {
            let index = entries
                .iter()
                .position(|(name, _)| name == key)
                .ok_or(PersonalGpuReceiptWireError)?;
            ordered.push(entries.remove(index));
        }
        if !entries.is_empty() {
            return Err(PersonalGpuReceiptWireError);
        }
        Ok(Json::Object(ordered))
    }
    if !super::verify_personal_gpu_operational_receipt(value) {
        return Err(PersonalGpuReceiptWireError);
    }
    let parsed: Json =
        serde_json::from_value(value.clone()).map_err(|_| PersonalGpuReceiptWireError)?;
    let Json::Object(mut entries) = reorder(parsed, &RECEIPT_ORDER)? else {
        return Err(PersonalGpuReceiptWireError);
    };
    for (key, value) in &mut entries {
        let keys: Option<&[&str]> = match key.as_str() {
            "localPolicy" => Some(&POLICY_ORDER),
            "releaseBoundary" => Some(&RELEASE_ORDER),
            _ => None,
        };
        if let Some(keys) = keys {
            *value = reorder(value.clone(), keys)?;
        }
    }
    pretty(&Json::Object(entries), 0)
}
