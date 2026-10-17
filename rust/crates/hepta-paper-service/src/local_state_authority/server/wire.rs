//! Preserve the two incumbent schema echo fields' JSON property order without
//! changing any receipt value. This is a transport projection only: signatures
//! and authority state are produced and checked by the normal typed handlers.
use super::{Result, error, files};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use serde_json::{Value, value::RawValue};

const INVALID: &str = "local_state_authority_request_invalid";
const BUDGET: &str = "local_state_authority_wire_echo_budget_exceeded";

#[derive(Deserialize)]
struct BorrowedFields<'a> {
    #[serde(borrow)]
    instances: Option<&'a RawValue>,
    #[serde(borrow)]
    installations: Option<&'a RawValue>,
}
#[derive(Deserialize)]
struct OwnedFields {
    instances: Option<Box<RawValue>>,
    installations: Option<Box<RawValue>>,
}
struct CapturedField {
    raw: Box<RawValue>,
    normalized: Value,
}
impl CapturedField {
    fn capture(raw: Box<RawValue>) -> Result<Self> {
        let normalized = files::parse(raw.get().as_bytes(), INVALID)?;
        Ok(Self { raw, normalized })
    }
    fn bind(self, actual: Option<&Value>) -> Option<Box<RawValue>> {
        (actual == Some(&self.normalized)).then_some(self.raw)
    }
}

/// Capture occurs before `runtime.handle`, so parsing/budget failure cannot be
/// confused with rejection of an already committed mutation. No caller JSON
/// authorizes a receipt: binding below compares with the actual returned value.
pub(super) struct CapturedEchoFields {
    instances: Option<CapturedField>,
    installations: Option<CapturedField>,
}
impl CapturedEchoFields {
    pub(super) fn capture(bytes: &[u8], maximum_extra_bytes: usize) -> Result<Self> {
        // The server already used the same strict parser; retain the check at
        // this private boundary so another caller cannot admit duplicate keys.
        files::parse(bytes, INVALID)?;
        let borrowed: BorrowedFields<'_> =
            serde_json::from_slice(bytes).map_err(|_| error(INVALID))?;
        let raw_length = [borrowed.instances, borrowed.installations]
            .into_iter()
            .flatten()
            .try_fold(0usize, |length, raw| length.checked_add(raw.get().len()))
            .ok_or_else(|| error(BUDGET))?;
        if raw_length > maximum_extra_bytes {
            return Err(error(BUDGET));
        }
        // Only these two explicitly named fields are copied. The borrowed pass
        // above accounts for them before any owned raw echo allocation.
        let fields: OwnedFields = serde_json::from_slice(bytes).map_err(|_| error(INVALID))?;
        Ok(Self {
            instances: fields.instances.map(CapturedField::capture).transpose()?,
            installations: fields
                .installations
                .map(CapturedField::capture)
                .transpose()?,
        })
    }
    pub(super) fn bind(self, receipt: &Value) -> SuccessEnvelope<'_> {
        SuccessEnvelope {
            receipt: Receipt {
                actual: receipt,
                instances: self
                    .instances
                    .and_then(|v| v.bind(receipt.get("instances"))),
                installations: self
                    .installations
                    .and_then(|v| v.bind(receipt.get("installations"))),
            },
        }
    }
}

pub(super) struct SuccessEnvelope<'a> {
    receipt: Receipt<'a>,
}
impl SuccessEnvelope<'_> {
    /// These raw bytes remain owned until serialization completes and must be
    /// subtracted from the connection's remaining wire-buffer allowance.
    pub(super) fn retained_bytes(&self) -> usize {
        self.receipt.instances.as_ref().map_or(0, |v| v.get().len())
            + self
                .receipt
                .installations
                .as_ref()
                .map_or(0, |v| v.get().len())
    }
}
impl Serialize for SuccessEnvelope<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut envelope = serializer.serialize_map(Some(2))?;
        envelope.serialize_entry("ok", &true)?;
        envelope.serialize_entry("receipt", &self.receipt)?;
        envelope.end()
    }
}
struct Receipt<'a> {
    actual: &'a Value,
    instances: Option<Box<RawValue>>,
    installations: Option<Box<RawValue>>,
}
impl Serialize for Receipt<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let Some(actual) = self.actual.as_object() else {
            return self.actual.serialize(serializer);
        };
        let mut receipt = serializer.serialize_map(Some(actual.len()))?;
        for (key, value) in actual {
            let raw = match key.as_str() {
                "instances" => self.instances.as_deref(),
                "installations" => self.installations.as_deref(),
                _ => None,
            };
            if let Some(raw) = raw {
                receipt.serialize_entry(key, raw)?;
            } else {
                receipt.serialize_entry(key, value)?;
            }
        }
        receipt.end()
    }
}

#[cfg(test)]
mod tests;
