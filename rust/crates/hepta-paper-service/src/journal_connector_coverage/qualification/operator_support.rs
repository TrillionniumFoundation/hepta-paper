//! Internal read-only bridge for the operator importer. This does not construct
//! the opaque verified inspection or convert a qualification into commit authority.
use super::*;
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

pub(crate) const EVIDENCE_TYPES: &[&str] = TYPES;
pub(crate) struct Document {
    raw: Json,
    pub value: Value,
}
impl Document {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let raw: Json = serde_json::from_slice(bytes)
            .map_err(|_| error("portal_target_qualification_file_invalid"))?;
        if !matches!(raw, Json::Object(_)) {
            return Err(error("portal_target_qualification_file_invalid"));
        }
        let value = raw.value();
        Ok(Self { raw, value })
    }
    pub fn structure_valid(&self) -> Result<bool> {
        registry_structure(&self.raw)
    }
    pub fn authority_blockers(&self, trust: &Self) -> Vec<String> {
        authority_blockers(&self.value, &trust.value).1
    }
    pub fn freshness(&self, now: i64) -> Vec<String> {
        freshness(&self.value, now)
    }
    pub fn entry_valid(&self, index: usize) -> Result<bool> {
        let Some(entry) = self
            .raw
            .get("entries")
            .and_then(Json::array)
            .and_then(|entries| entries.get(index))
        else {
            return Ok(false);
        };
        let targets = build_journal_submission_target_registry_v1(&journal_profiles_v2()?)?;
        let families = build_submission_connector_family_registry_v1()?;
        Ok(entry_valid(
            entry,
            targets["targets"]
                .as_array()
                .ok_or_else(|| error("portal_target_qualification_target_binding_invalid"))?,
            families["families"]
                .as_array()
                .ok_or_else(|| error("portal_target_qualification_target_binding_invalid"))?,
        ))
    }
    pub fn evidence_valid(&self, index: usize, kind: &str) -> bool {
        self.raw
            .get("entries")
            .and_then(Json::array)
            .and_then(|entries| entries.get(index))
            .and_then(|entry| entry.get("evidence"))
            .and_then(|evidence| evidence.get(kind))
            .is_some_and(|evidence| {
                evidence_valid(
                    evidence,
                    kind,
                    evidence.value()["subjectHash"].as_str().unwrap_or(""),
                )
            })
    }
    pub fn publication_bytes(&self) -> Result<Vec<u8>> {
        let mut bytes = serde_json::to_vec_pretty(&Ordered(&self.raw))
            .map_err(|_| error("portal_target_qualification_file_invalid"))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}
struct Ordered<'a>(&'a Json);
impl Serialize for Ordered<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self.0 {
            Json::Scalar(value) => value.serialize(serializer),
            Json::Array(values) => {
                let mut seq = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    seq.serialize_element(&Ordered(value))?;
                }
                seq.end()
            }
            Json::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(key, &Ordered(value))?;
                }
                map.end()
            }
        }
    }
}
pub(crate) fn evidence_policy(kind: &str) -> Option<(&'static str, i64)> {
    policy(kind).map(|p| (p.role, p.maximum_age))
}
pub(crate) fn subject_hash(value: &Value) -> Result<Option<String>> {
    let targets = build_journal_submission_target_registry_v1(&journal_profiles_v2()?)?;
    let families = build_submission_connector_family_registry_v1()?;
    let Some(target) = targets["targets"]
        .as_array()
        .ok_or_else(|| error("portal_target_qualification_target_binding_invalid"))?
        .iter()
        .find(|t| t["venueId"] == value["venueId"])
    else {
        return Ok(None);
    };
    let Some(family) = families["families"]
        .as_array()
        .ok_or_else(|| error("portal_target_qualification_target_binding_invalid"))?
        .iter()
        .find(|f| f["connectorFamily"] == value["connectorFamily"])
    else {
        return Ok(None);
    };
    if !safe_id(
        &value["targetInstanceId"],
        family["connectorFamily"] == "openreview-api-v2",
    ) || !optional_text(&value["edition"])
        || !optional_text(&value["track"])
        || target["venueKind"] != value["venueKind"]
        || target["journalSubmissionTargetProfileHash"] != value["baseTargetProfileHash"]
        || !target["candidateConnectorFamilies"]
            .as_array()
            .is_some_and(|a| a.contains(&family["connectorFamily"]))
        || target["adapterImplemented"] != true
        || family["capabilities"]["discoverProfile"] != true
        || (target["venueKind"] == "conference"
            && (!truthy(&value["edition"]) || !truthy(&value["track"])))
    {
        return Ok(None);
    }
    let mut subject = json!({"version":1,"kind":"PortalTargetQualificationSubject"});
    for key in SUBJECT_KEYS {
        subject[*key] = value[*key].clone();
    }
    for key in HASH_FIELDS {
        let lower = value[*key].as_str().unwrap_or("").to_lowercase();
        if !sha(&json!(lower)) {
            return Ok(None);
        }
        subject[*key] = json!(lower);
    }
    Ok(
        production_hash_record_v1("PortalTargetQualificationSubject", &subject)
            .ok()
            .map(|h| h.as_str().to_owned()),
    )
}
