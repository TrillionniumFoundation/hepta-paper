//! Local verification of pinned, independently signed qualification registries.
//! The opaque inspection can only be constructed after the complete verification
//! chain. It never produces a live-commit permit or performs a network action.
pub(crate) mod operator_support;
use super::qualification_authority::{AuthorityVerification, verify_authority};
use super::qualification_json::Json;
use super::{
    Result, build_journal_submission_target_registry_v1,
    build_submission_connector_family_registry_v1, error, journal_profiles_v2, record, truthy,
};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

pub(super) const OWNER: &str = "portal_target_owner";
pub(super) const OBSERVER: &str = "portal_target_independent_observer";
pub(super) const AUTHORIZER: &str = "portal_production_authorizer";
pub(super) const TYPES: &[&str] = &[
    "discovery",
    "sandboxCanary",
    "portalIdentity",
    "dispatcherChallenge",
    "cycleRecovery",
    "productionAuthorization",
];
const SIGNATURE_KEYS: &[&str] = &["keyId", "role", "algorithm", "value"];
const EVIDENCE_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "evidenceType",
    "artifactKind",
    "artifactHash",
    "verificationReceiptKind",
    "verificationReceiptHash",
    "verificationPolicyHash",
    "verifierRole",
    "issuerPrincipalId",
    "subjectHash",
    "evidenceEnvironment",
    "observedAt",
    "expiresAt",
    "authorizationScope",
    "fixtureEvidence",
    "externalActionPerformed",
    "liveCommitPerformed",
    "signatures",
];
const SUBJECT_KEYS: &[&str] = &[
    "venueId",
    "venueKind",
    "baseTargetProfileHash",
    "targetInstanceId",
    "edition",
    "track",
    "connectorFamily",
    "portalOriginHash",
    "submissionRouteHash",
    "schemaFingerprintHash",
    "authenticationProfileHash",
    "automationPolicyEvidenceHash",
    "statusMappingHash",
    "portalConfigurationHash",
    "portalDescriptorHash",
];
const HASH_FIELDS: &[&str] = &[
    "portalOriginHash",
    "submissionRouteHash",
    "schemaFingerprintHash",
    "authenticationProfileHash",
    "automationPolicyEvidenceHash",
    "statusMappingHash",
    "portalConfigurationHash",
    "portalDescriptorHash",
];
const ENTRY_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "venueId",
    "venueKind",
    "baseTargetProfileHash",
    "targetInstanceId",
    "edition",
    "track",
    "connectorFamily",
    "portalOriginHash",
    "submissionRouteHash",
    "schemaFingerprintHash",
    "authenticationProfileHash",
    "automationPolicyEvidenceHash",
    "statusMappingHash",
    "portalConfigurationHash",
    "portalDescriptorHash",
    "portalTargetSubjectHash",
    "qualificationLevel",
    "qualifiedAt",
    "expiresAt",
    "evidence",
    "sandboxQualified",
    "productionQualified",
    "liveCommitAuthorized",
    "humanSingleUseAuthorizationRequired",
    "liveCommitPermitHash",
    "portalTargetQualificationHash",
];
const REGISTRY_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "generation",
    "issuedAt",
    "expiresAt",
    "maximumTargetCount",
    "entries",
    "predecessorRegistryHash",
    "revokedQualificationHashes",
    "liveCommitAuthorizationIncluded",
    "humanSingleUseAuthorizationRequired",
    "portalTargetQualificationRegistryHash",
    "signatures",
];

pub(super) struct Policy {
    artifact: &'static str,
    receipt: &'static str,
    pub role: &'static str,
    environment: &'static str,
    scope: Option<&'static str>,
    external: bool,
    maximum_age: i64,
    maximum_lifetime: i64,
}
pub(super) fn policy(kind: &str) -> Option<Policy> {
    let (artifact, receipt, role, environment, scope, external, maximum_age, maximum_lifetime) =
        match kind {
            "discovery" => (
                "SubmissionPortalBinding",
                "PortalTargetDiscoveryVerificationReceipt",
                OWNER,
                "production",
                None,
                true,
                86_400_000,
                172_800_000,
            ),
            "sandboxCanary" => (
                "AutonomousSubmissionPortalReadinessCanaryEvidence",
                "AutonomousSubmissionPortalReadinessCanaryVerificationReceipt",
                OBSERVER,
                "sandbox",
                None,
                false,
                3_600_000,
                7_200_000,
            ),
            "portalIdentity" => (
                "AutonomousSubmissionPortalIdentitySeparationInspection",
                "AutonomousSubmissionPortalIdentitySeparationInspection",
                OBSERVER,
                "production",
                None,
                false,
                3_600_000,
                7_200_000,
            ),
            "dispatcherChallenge" => (
                "AutonomousSubmissionDispatcherChallenge",
                "AutonomousSubmissionDispatcherChallengeVerificationReceipt",
                OBSERVER,
                "production",
                None,
                false,
                3_600_000,
                7_200_000,
            ),
            "cycleRecovery" => (
                "AutonomousSubmissionDispatcherCycleReceipt",
                "AutonomousSubmissionDispatcherCycleReceipt",
                OBSERVER,
                "sandbox",
                None,
                false,
                3_600_000,
                7_200_000,
            ),
            "productionAuthorization" => (
                "ProviderCapabilityVerificationReceipt",
                "PortalTargetProductionQualificationAuthorizationReceipt",
                AUTHORIZER,
                "production",
                Some("portal-qualification-only"),
                false,
                1_800_000,
                3_600_000,
            ),
            _ => return None,
        };
    Some(Policy {
        artifact,
        receipt,
        role,
        environment,
        scope,
        external,
        maximum_age,
        maximum_lifetime,
    })
}
fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 71
            && s.starts_with("sha256:")
            && s[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn safe_id(value: &Value, openreview: bool) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes().all(|b| {
                b.is_ascii_alphanumeric()
                    || if openreview {
                        b"._/-".contains(&b)
                    } else {
                        b"_.:@/-".contains(&b)
                    }
            })
            && (!openreview || !s.contains("/-/"))
    })
}
fn optional_text(value: &Value) -> bool {
    value.is_null()
        || value
            .as_str()
            .is_some_and(|s| !s.is_empty() && js_trim(s) == s && s.encode_utf16().count() <= 256)
}
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
/// Exact Date#toISOString form, including ECMAScript's signed six-digit years.
/// Values outside the Date range or normalized (e.g. February 30) are rejected.
pub fn canonical_instant_millis(value: &str) -> Option<i64> {
    let (year, rest) = if value.starts_with(['+', '-']) {
        if value.len() != 27 {
            return None;
        }
        let year = value.get(..7)?.parse::<i64>().ok()?;
        if (0..10_000).contains(&year) || value.starts_with("-000000") {
            return None;
        }
        (year, value.get(7..)?)
    } else {
        if value.len() != 24 || !value.get(..4)?.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        (value.get(..4)?.parse::<i64>().ok()?, value.get(4..)?)
    };
    let bytes = rest.as_bytes();
    if bytes.len() != 20
        || bytes[0] != b'-'
        || bytes[3] != b'-'
        || bytes[6] != b'T'
        || bytes[9] != b':'
        || bytes[12] != b':'
        || bytes[15] != b'.'
        || bytes[19] != b'Z'
    {
        return None;
    }
    let number = |start: usize, end: usize| -> Option<i64> {
        let text = rest.get(start..end)?;
        if !text.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    };
    let month = number(1, 3)?;
    let day = number(4, 6)?;
    let hour = number(7, 9)?;
    let minute = number(10, 12)?;
    let second = number(13, 15)?;
    let millis = number(16, 19)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    if !(1..=max_day).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468;
    let result = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + millis;
    (result.abs() <= 8_640_000_000_000_000).then_some(result)
}
fn instant(value: &Value) -> Option<i64> {
    canonical_instant_millis(value.as_str()?)
}
fn signatures(value: &Json) -> bool {
    value.array().is_some_and(|values| {
        values.iter().all(|signature| {
            let v = signature.value();
            signature.ordered_keys(SIGNATURE_KEYS)
                && v["algorithm"] == "ed25519"
                && safe_id(&v["keyId"], false)
                && v["role"]
                    .as_str()
                    .is_some_and(|s| [OWNER, OBSERVER, AUTHORIZER].contains(&s))
                && v["value"].as_str().is_some_and(|s| !s.is_empty())
        })
    })
}
fn evidence_valid(input: &Json, kind: &str, subject_hash: &str) -> bool {
    let Some(policy) = policy(kind) else {
        return false;
    };
    let v = input.value();
    let Some(observed) = instant(&v["observedAt"]) else {
        return false;
    };
    let Some(expires) = instant(&v["expiresAt"]) else {
        return false;
    };
    input.ordered_keys(EVIDENCE_KEYS)
        && v["version"] == 1
        && v["kind"] == "PortalTargetQualificationEvidenceAttestation"
        && v["status"] == "portal_target_evidence_cryptographically_attested"
        && v["evidenceType"] == kind
        && v["artifactKind"] == policy.artifact
        && v["verificationReceiptKind"] == policy.receipt
        && v["verifierRole"] == policy.role
        && v["evidenceEnvironment"] == policy.environment
        && v["authorizationScope"] == json!(policy.scope)
        && v["fixtureEvidence"] == false
        && v["externalActionPerformed"] == policy.external
        && v["liveCommitPerformed"] == false
        && safe_id(&v["issuerPrincipalId"], false)
        && v["subjectHash"] == subject_hash
        && [
            "artifactHash",
            "verificationReceiptHash",
            "verificationPolicyHash",
            "subjectHash",
        ]
        .iter()
        .all(|key| sha(&v[*key]))
        && expires > observed
        && expires - observed <= policy.maximum_lifetime
        && input.get("signatures").is_some_and(signatures)
}
fn entry_valid(input: &Json, targets: &[Value], families: &[Value]) -> bool {
    let value = input.value();
    if !input.ordered_keys(ENTRY_KEYS)
        || value["version"] != 1
        || value["kind"] != "PortalTargetQualification"
        || !["sandbox", "production"]
            .iter()
            .any(|level| value["qualificationLevel"] == *level)
        || value["liveCommitAuthorized"] != false
        || value["humanSingleUseAuthorizationRequired"] != true
        || !value["liveCommitPermitHash"].is_null()
        || !sha(&value["portalTargetQualificationHash"])
    {
        return false;
    }
    let production = value["qualificationLevel"] == "production";
    if value["status"]
        != if production {
            "portal_target_production_qualified"
        } else {
            "portal_target_sandbox_qualified"
        }
        || value["sandboxQualified"] != true
        || value["productionQualified"] != production
    {
        return false;
    }
    let Some(target) = targets
        .iter()
        .find(|target| target["venueId"] == value["venueId"])
    else {
        return false;
    };
    let Some(family) = families
        .iter()
        .find(|family| family["connectorFamily"] == value["connectorFamily"])
    else {
        return false;
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
        || !HASH_FIELDS.iter().all(|key| sha(&value[*key]))
    {
        return false;
    }
    let mut subject = json!({"version": 1, "kind": "PortalTargetQualificationSubject"});
    for key in SUBJECT_KEYS {
        subject[*key] = value[*key].clone();
    }
    let Ok(subject_hash) = production_hash_record_v1("PortalTargetQualificationSubject", &subject)
    else {
        return false;
    };
    if value["portalTargetSubjectHash"] != subject_hash.as_str() {
        return false;
    }
    let Some(qualified) = instant(&value["qualifiedAt"]) else {
        return false;
    };
    let Some(expires) = instant(&value["expiresAt"]) else {
        return false;
    };
    if expires <= qualified {
        return false;
    }
    let Some(evidence) = input.get("evidence") else {
        return false;
    };
    if !evidence.ordered_keys(TYPES) {
        return false;
    }
    for (index, kind) in TYPES.iter().enumerate() {
        let Some(reference) = evidence.get(kind) else {
            return false;
        };
        if production || index < 3 {
            if !evidence_valid(reference, kind, subject_hash.as_str())
                || instant(&reference.value()["observedAt"])
                    .is_none_or(|observed| observed > qualified)
            {
                return false;
            }
        } else if !reference.value().is_null() {
            return false;
        }
    }
    let mut payload = value.clone();
    let Some(payload_object) = payload.as_object_mut() else {
        return false;
    };
    payload_object.remove("portalTargetQualificationHash");
    production_hash_record_v1("PortalTargetQualification", &payload)
        .is_ok_and(|hash| value["portalTargetQualificationHash"] == hash.as_str())
}
fn registry_structure(input: &Json) -> Result<bool> {
    let value = input.value();
    if !input.ordered_keys(REGISTRY_KEYS)
        || value["version"] != 1
        || value["kind"] != "PortalTargetQualificationRegistry"
        || value["status"] != "portal_target_qualification_registry_active"
        || value["maximumTargetCount"] != 2
        || value["liveCommitAuthorizationIncluded"] != false
        || value["humanSingleUseAuthorizationRequired"] != true
        || !sha(&value["portalTargetQualificationRegistryHash"])
        || !input.get("signatures").is_some_and(signatures)
    {
        return Ok(false);
    }
    let Some(generation) = value["generation"]
        .as_u64()
        .filter(|v| (1..=9_007_199_254_740_991).contains(v))
    else {
        return Ok(false);
    };
    if (generation == 1 && !value["predecessorRegistryHash"].is_null())
        || (generation > 1 && !sha(&value["predecessorRegistryHash"]))
    {
        return Ok(false);
    }
    let Some(revoked) = value["revokedQualificationHashes"].as_array() else {
        return Ok(false);
    };
    if !revoked.iter().all(sha)
        || revoked
            .windows(2)
            .any(|pair| pair[0].as_str() >= pair[1].as_str())
    {
        return Ok(false);
    }
    let Some(issued) = instant(&value["issuedAt"]) else {
        return Ok(false);
    };
    let Some(expires) = instant(&value["expiresAt"]) else {
        return Ok(false);
    };
    if expires <= issued || expires - issued > 604_800_000 {
        return Ok(false);
    }
    let Some(entries) = input
        .get("entries")
        .and_then(Json::array)
        .filter(|v| v.len() <= 2)
    else {
        return Ok(false);
    };
    let targets = build_journal_submission_target_registry_v1(&journal_profiles_v2()?)?;
    let families = build_submission_connector_family_registry_v1()?;
    let target_entries = targets["targets"]
        .as_array()
        .ok_or_else(|| error("journal_submission_target_registry_invalid"))?;
    let family_entries = families["families"]
        .as_array()
        .ok_or_else(|| error("submission_connector_family_registry_invalid"))?;
    let mut venue_ids = BTreeSet::new();
    let mut instances = BTreeSet::new();
    let mut last_venue = String::new();
    for entry in entries {
        if !entry_valid(entry, target_entries, family_entries) {
            return Ok(false);
        }
        let entry = entry.value();
        let Some(venue) = entry["venueId"].as_str() else {
            return Ok(false);
        };
        let Some(instance) = entry["targetInstanceId"].as_str() else {
            return Ok(false);
        };
        // Qualifiable venue ids are ASCII iclr, icml, neurips, tmlr; lexical and locale order agree.
        if venue < last_venue.as_str()
            || !venue_ids.insert(venue.to_owned())
            || !instances.insert(instance.to_owned())
        {
            return Ok(false);
        }
        last_venue = venue.to_owned();
        if instant(&entry["qualifiedAt"]).is_none_or(|qualified| qualified > issued)
            || instant(&entry["expiresAt"]).is_none_or(|expiry| expiry < expires)
        {
            return Ok(false);
        }
        for kind in TYPES {
            let evidence = &entry["evidence"][*kind];
            if evidence.is_null() {
                continue;
            }
            let Some(observed) = instant(&evidence["observedAt"]) else {
                return Ok(false);
            };
            let Some(evidence_policy) = policy(kind) else {
                return Ok(false);
            };
            if observed > issued
                || instant(&evidence["expiresAt"]).is_none_or(|expiry| expiry < expires)
                || issued - observed > evidence_policy.maximum_age
            {
                return Ok(false);
            }
        }
    }
    let mut payload = value.clone();
    let Some(payload_object) = payload.as_object_mut() else {
        return Ok(false);
    };
    payload_object.remove("portalTargetQualificationRegistryHash");
    payload_object.remove("signatures");
    Ok(
        production_hash_record_v1("PortalTargetQualificationRegistry", &payload)
            .is_ok_and(|hash| value["portalTargetQualificationRegistryHash"] == hash.as_str()),
    )
}

fn normalized_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| error("portal_target_qualification_file_invalid"))?
            .join(path)
    };
    let mut result = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(part),
        }
    }
    Ok(result)
}
struct ReadJson {
    path: PathBuf,
    file_hash: String,
    value: Json,
}
fn read_secure(path: &Path, expected: Option<&str>, code: &str) -> Result<ReadJson> {
    let selected = normalized_path(path)?;
    if !selected.exists() {
        return Err(error(format!("{code}:missing")));
    }
    let failed = || error(code);
    let metadata = fs::symlink_metadata(&selected).map_err(|_| failed())?;
    let uid = nix::unistd::getuid().as_raw();
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() != 1
        || !(2..=4 * 1024 * 1024).contains(&metadata.len())
        || metadata.mode() & 0o022 != 0
        || (metadata.uid() != 0 && metadata.uid() != uid)
        || fs::canonicalize(&selected).map_err(|_| failed())? != selected
    {
        return Err(failed());
    }
    let mut descriptor = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&selected)
        .map_err(|_| failed())?;
    let before = descriptor.metadata().map_err(|_| failed())?;
    let mut bytes = Vec::new();
    (&mut descriptor)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failed())?;
    let after = descriptor.metadata().map_err(|_| failed())?;
    if !before.is_file()
        || before.nlink() != 1
        || before.dev() != metadata.dev()
        || before.ino() != metadata.ino()
        || before.len() != bytes.len() as u64
        || after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
    {
        return Err(failed());
    }
    let file_hash = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    if expected.is_some_and(|pin| pin != file_hash) {
        return Err(failed());
    }
    let value: Json = serde_json::from_slice(&bytes).map_err(|_| failed())?;
    if !matches!(value, Json::Object(_)) {
        return Err(failed());
    }
    Ok(ReadJson {
        path: selected,
        file_hash,
        value,
    })
}
fn pin(value: Option<&str>, code: &str, required: bool) -> Result<Option<String>> {
    match value.filter(|v| !v.is_empty()) {
        Some(value) => {
            let value = value.to_lowercase();
            if !sha(&json!(value)) {
                return Err(error(code));
            }
            Ok(Some(value))
        }
        None if required => Err(error(code)),
        None => Ok(None),
    }
}
fn freshness(registry: &Value, now: i64) -> Vec<String> {
    if now.unsigned_abs() > 8_640_000_000_000_000 {
        return vec!["portal_target_qualification_clock_invalid".into()];
    }
    let mut blockers = Vec::new();
    let (Some(issued), Some(expires)) = (
        instant(&registry["issuedAt"]),
        instant(&registry["expiresAt"]),
    ) else {
        return vec!["portal_target_qualification_registry_structure_invalid".into()];
    };
    if now < issued {
        blockers.push("portal_target_qualification_registry_not_yet_valid".into());
    }
    if now >= expires {
        blockers.push("portal_target_qualification_registry_expired".into());
    }
    blockers
}
fn authority_blockers(registry: &Value, trust: &Value) -> (AuthorityVerification, Vec<String>) {
    let Some(entries) = registry["entries"].as_array() else {
        let verification = verify_authority(registry, trust, &[OWNER, OBSERVER]);
        let mut blockers = verification.blockers.clone();
        blockers.push("portal_target_qualification_registry_structure_invalid".into());
        return (verification, blockers);
    };
    let production = entries
        .iter()
        .any(|entry| entry["productionQualified"] == true);
    let roles = if production {
        vec![OWNER, OBSERVER, AUTHORIZER]
    } else {
        vec![OWNER, OBSERVER]
    };
    let verified = verify_authority(registry, trust, &roles);
    let mut blockers = verified.blockers.clone();
    if registry["signatures"].as_array().map(Vec::len) != Some(roles.len()) {
        blockers.push("portal_target_qualification_signature_set_not_minimal".into());
    }
    let organizations = verified
        .signatures
        .iter()
        .map(|s| js_trim(&super::js_string(&s.value["organization"])).to_lowercase())
        .collect::<Vec<_>>();
    if verified
        .signatures
        .iter()
        .any(|s| s.value["organization"].is_null())
        || organizations.iter().any(String::is_empty)
        || organizations.iter().collect::<BTreeSet<_>>().len() != organizations.len()
    {
        blockers.push("portal_target_qualification_authority_organizations_not_independent".into());
    }
    let fingerprints = verified
        .signatures
        .iter()
        .map(|s| &s.spki)
        .collect::<BTreeSet<_>>();
    if fingerprints.len() != verified.signatures.len() {
        blockers.push("portal_target_qualification_authority_spki_not_independent".into());
    }
    let signer = |role: &str| {
        verified
            .signatures
            .iter()
            .rev()
            .find(|s| s.value["role"] == role)
    };
    for entry in entries {
        let Some(venue) = entry["venueId"].as_str() else {
            blockers.push("portal_target_qualification_registry_structure_invalid".into());
            continue;
        };
        if signer(OWNER).is_none_or(|s| {
            entry["evidence"]["discovery"]["issuerPrincipalId"] != s.value["subjectId"]
        }) {
            blockers.push(format!("portal_target_discovery_owner_mismatch:{venue}"));
        }
        for kind in [
            "sandboxCanary",
            "portalIdentity",
            "dispatcherChallenge",
            "cycleRecovery",
        ] {
            let evidence = &entry["evidence"][kind];
            if !evidence.is_null()
                && signer(OBSERVER)
                    .is_none_or(|s| evidence["issuerPrincipalId"] != s.value["subjectId"])
            {
                blockers.push(format!("portal_target_observer_mismatch:{venue}:{kind}"));
            }
        }
        if entry["productionQualified"] == true
            && signer(AUTHORIZER).is_none_or(|s| {
                entry["evidence"]["productionAuthorization"]["issuerPrincipalId"]
                    != s.value["subjectId"]
            })
        {
            blockers.push(format!(
                "portal_target_production_authorizer_mismatch:{venue}"
            ));
        }
        for kind in TYPES {
            let evidence = &entry["evidence"][*kind];
            if evidence.is_null() {
                continue;
            }
            let Some(evidence_policy) = policy(kind) else {
                blockers.push(format!(
                    "{venue}:{kind}:portal_target_evidence_policy_missing"
                ));
                continue;
            };
            let role = evidence_policy.role;
            let check = verify_authority(evidence, trust, &[role]);
            let mut evidence_blockers = check.blockers.clone();
            if evidence["signatures"].as_array().map(Vec::len) != Some(1) {
                evidence_blockers.push("portal_target_evidence_signature_set_not_minimal".into());
            }
            let actual = check.signatures.first();
            let expected = signer(role);
            if actual.is_none_or(|s| {
                s.value["role"] != evidence["verifierRole"]
                    || s.value["subjectId"] != evidence["issuerPrincipalId"]
            }) || actual.zip(expected).is_none_or(|(a, b)| {
                a.value["subjectId"] != b.value["subjectId"] || a.value["keyId"] != b.value["keyId"]
            }) {
                evidence_blockers.push("portal_target_evidence_verifier_identity_mismatch".into());
            }
            blockers.extend(
                evidence_blockers
                    .into_iter()
                    .map(|blocker| format!("{venue}:{kind}:{blocker}")),
            );
        }
    }
    (verified, blockers)
}

/// Read-only inputs; expectedRegistryHash pins the semantic hash, trust hash pins bytes.
pub struct PortalTargetQualificationOptionsV1<'a> {
    pub registry_path: &'a Path,
    pub trust_store_path: Option<&'a Path>,
    pub expected_registry_hash: Option<&'a str>,
    pub expected_trust_store_hash: Option<&'a str>,
    pub now_unix_ms: i64,
}
/// Opaque provenance prevents callers from forging a verified inspection from JSON.
pub struct PortalTargetQualificationInspectionV1 {
    report: Value,
    registry: Option<Value>,
}
impl PortalTargetQualificationInspectionV1 {
    pub fn report(&self) -> &Value {
        &self.report
    }
    pub fn ready(&self) -> bool {
        self.registry.is_some()
    }
}
pub fn inspect_portal_target_qualification_registry_v1(
    options: PortalTargetQualificationOptionsV1<'_>,
) -> Result<PortalTargetQualificationInspectionV1> {
    let mut blockers = Vec::new();
    let registry_read = match read_secure(
        options.registry_path,
        None,
        "portal_target_qualification_registry_file_invalid",
    ) {
        Ok(value) => Some(value),
        Err(err) => {
            blockers.push(err.to_string());
            None
        }
    };
    let trust_read = match pin(
        options.expected_trust_store_hash,
        "portal_target_qualification_trust_store_pin_required",
        true,
    )
    .and_then(|pin| {
        read_secure(
            options.trust_store_path.unwrap_or(Path::new("")),
            pin.as_deref(),
            "portal_target_qualification_trust_store_invalid",
        )
    }) {
        Ok(value) => Some(value),
        Err(err) => {
            blockers.push(err.to_string());
            None
        }
    };
    let mut semantic_pin_verified = false;
    let mut authority = None;
    let mut valid_registry = None;
    if let (Some(registry), Some(trust)) = (&registry_read, &trust_read) {
        let valid = registry_structure(&registry.value)?;
        if valid {
            valid_registry = Some(registry.value.value());
        } else {
            blockers.push("portal_target_qualification_registry_structure_invalid".into());
        }
        let expected = pin(
            options.expected_registry_hash,
            "portal_target_qualification_registry_pin_invalid",
            false,
        )?;
        semantic_pin_verified = expected.as_ref().is_some_and(|expected| {
            valid_registry.as_ref().is_some_and(|registry| {
                registry["portalTargetQualificationRegistryHash"] == *expected
            })
        });
        if expected.is_some() && !semantic_pin_verified {
            blockers.push("portal_target_qualification_registry_pin_mismatch".into());
        }
        if blockers.is_empty() {
            let selected_registry = valid_registry
                .as_ref()
                .ok_or_else(|| error("portal_target_qualification_registry_structure_invalid"))?;
            let (verification, failed) =
                authority_blockers(selected_registry, &trust.value.value());
            blockers.extend(failed);
            authority = Some(verification);
        }
        if blockers.is_empty() {
            blockers.extend(freshness(
                valid_registry.as_ref().ok_or_else(|| {
                    error("portal_target_qualification_registry_structure_invalid")
                })?,
                options.now_unix_ms,
            ));
        }
        if !semantic_pin_verified {
            blockers.push("portal_target_qualification_registry_semantic_pin_required".into());
        }
    }
    let registry = valid_registry
        .or_else(|| registry_read.as_ref().map(|read| read.value.value()))
        .unwrap_or(Value::Null);
    let ready = blockers.is_empty();
    let entries = if ready {
        registry["entries"]
            .as_array()
            .ok_or_else(|| error("portal_target_qualification_registry_structure_invalid"))?
            .clone()
    } else {
        Vec::new()
    };
    blockers.sort();
    blockers.dedup();
    let nullable = |v: &Value| if truthy(v) { v.clone() } else { Value::Null };
    let report = json!({
        "version": 1, "kind": "PortalTargetQualificationRegistryInspection",
        "status": if ready { "portal_target_qualification_registry_ready" } else { "portal_target_qualification_registry_blocked" },
        "ready": ready,
        "registryPath": registry_read.as_ref().map(|read| read.path.clone()).unwrap_or(normalized_path(options.registry_path)?),
        "registryFileHash": registry_read.as_ref().map(|read| &read.file_hash), "registryHash": nullable(&registry["portalTargetQualificationRegistryHash"]),
        "semanticPinVerified": semantic_pin_verified, "trustStoreFileHash": trust_read.as_ref().map(|read| &read.file_hash),
        "generation": nullable(&registry["generation"]), "expiresAt": nullable(&registry["expiresAt"]),
        "sandboxQualifiedTargetCount": entries.iter().filter(|entry| truthy(&entry["sandboxQualified"])).count(),
        "productionQualifiedTargetCount": entries.iter().filter(|entry| truthy(&entry["productionQualified"])).count(),
        "liveCommitAuthorizedTargetCount": 0, "humanSingleUseAuthorizationRequired": true, "entries": entries,
        "registry": if ready { registry.clone() } else { Value::Null }, "signatureVerification": authority.as_ref().map(|a| &a.report), "blockers": blockers,
        "safety": { "externalActionPerformed": false, "referencedEvidenceExternalActionPerformed": !entries.is_empty() && entries.iter().all(|entry| TYPES.iter().any(|kind| entry["evidence"][*kind]["externalActionPerformed"] == true)), "networkActionPerformed": false, "credentialUsed": false, "liveCommitPermitProduced": false, "liveCommitPermitConsumed": false },
    });
    Ok(PortalTargetQualificationInspectionV1 {
        report,
        registry: ready.then_some(registry),
    })
}

pub fn apply_inspected_portal_target_qualifications_v1(
    coverage: &Value,
    inspection: &PortalTargetQualificationInspectionV1,
    now_unix_ms: i64,
) -> Result<Value> {
    let registry = inspection
        .registry
        .as_ref()
        .ok_or_else(|| error("portal_target_qualification_verified_inspection_required"))?;
    let fresh = freshness(registry, now_unix_ms);
    if !fresh.is_empty() {
        return Err(error(format!(
            "portal_target_qualification_registry_not_current:{}",
            fresh.join(",")
        )));
    }
    let mut entries = coverage["entries"]
        .as_array()
        .ok_or_else(|| error("journal_submission_connector_coverage_entries_required"))?
        .clone();
    let qualifications = registry["entries"]
        .as_array()
        .ok_or_else(|| error("portal_target_qualification_registry_structure_invalid"))?;
    for entry in &mut entries {
        let Some(qualification) = qualifications
            .iter()
            .find(|q| q["venueId"] == entry["venueId"])
        else {
            continue;
        };
        let production = qualification["productionQualified"] == true;
        entry
            .as_object_mut()
            .ok_or_else(|| error("journal_submission_connector_coverage_entry_invalid"))?
            .remove("journalSubmissionConnectorCoverageEntryHash");
        entry["connectorDisposition"] = json!(if production {
            "cryptographically_attested_target_production_qualified"
        } else {
            "cryptographically_attested_target_sandbox_qualified"
        });
        entry["targetProfileResolved"] = json!(true);
        entry["sandboxQualified"] = json!(true);
        entry["productionQualified"] = json!(production);
        entry["liveCommitAuthorized"] = json!(false);
        entry["liveSubmissionReady"] = json!(false);
        entry["discoveryRequired"] = json!(false);
        entry["blockers"] = if production {
            json!(["final_commit_human_review_and_single_use_permit_required"])
        } else {
            json!([
                "portal_target_production_authorization_required",
                "final_commit_human_review_and_single_use_permit_required"
            ])
        };
        *entry = record(
            "JournalSubmissionConnectorCoverageEntry",
            "journalSubmissionConnectorCoverageEntryHash",
            entry.clone(),
        )?;
    }
    Ok(
        json!({"entries": entries, "portalTargetQualificationRegistryHash": inspection.report["registryHash"], "qualificationGeneration": inspection.report["generation"], "qualificationExpiresAt": inspection.report["expiresAt"]}),
    )
}
