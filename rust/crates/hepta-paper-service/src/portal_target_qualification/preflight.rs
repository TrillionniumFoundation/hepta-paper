use super::*;
use crate::journal_connector_coverage::{
    build_journal_submission_target_registry_v1, journal_profiles_v2,
    qualification::operator_support::{evidence_policy, subject_hash},
};
use hepta_legacy_compatibility::ProductionCollationV1;
use std::collections::BTreeSet;

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn javascript_string(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(_) => hepta_legacy_compatibility::production_stable_json_v1(value)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_else(|| value.to_string()),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    javascript_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
struct Source {
    configured: bool,
    missing: bool,
    read: Option<files::Snapshot>,
    valid: bool,
}
impl Source {
    fn load(path: Option<&std::path::Path>) -> Result<Self> {
        let configured = path.is_some_and(|p| !p.as_os_str().to_string_lossy().trim().is_empty());
        let missing = !configured || !files::normalize(path)?.exists();
        let read = if missing {
            None
        } else {
            files::read(path, None, "portal_target_qualification_file_invalid").ok()
        };
        let valid = read
            .as_ref()
            .map(|r| r.document.structure_valid())
            .transpose()?
            .unwrap_or(false);
        Ok(Self {
            configured,
            missing,
            read,
            valid,
        })
    }
    fn value(&self) -> &Value {
        self.read
            .as_ref()
            .map(|r| &r.document.value)
            .unwrap_or(&Value::Null)
    }
    fn readable(&self) -> bool {
        self.read.is_some()
    }
}
struct Pin {
    configured: bool,
    valid: bool,
    matched: bool,
}
impl Pin {
    fn new(value: Option<&str>, observed: Option<&str>) -> Self {
        let configured = value.is_some_and(|v| !v.is_empty());
        let lower = value.unwrap_or("").to_lowercase();
        let valid = configured && sha(&lower);
        Self {
            configured,
            valid,
            matched: valid && observed == Some(lower.as_str()),
        }
    }
}
fn add(
    blockers: &mut Vec<Value>,
    suffix: &str,
    kind: &str,
    venue: Option<&str>,
    evidence: Option<&str>,
) {
    blockers.push(json!({"version":1,"kind":"PortalTargetQualificationPreflightBlocker","errorCode":format!("portal_target_qualification_preflight_{suffix}"),"blockerType":kind,"targetVenueId":venue,"evidenceType":evidence}));
}
fn each(blockers: &mut Vec<Value>, profiles: &[Value], suffix: &str, kind: &str) {
    for p in profiles {
        add(blockers, suffix, kind, p["venueId"].as_str(), None);
    }
}
fn entries(value: &Value) -> &[Value] {
    value["entries"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn source_blockers(
    blockers: &mut Vec<Value>,
    profiles: &[Value],
    sources: (&Source, &Source, &Source),
    pins: (&Pin, &Pin, &Pin),
) {
    let (active, candidate, trust) = sources;
    let (registry_pin, candidate_pin, trust_pin) = pins;
    let selected = if candidate.configured {
        candidate
    } else {
        active
    };
    if !candidate.configured && (!active.configured || active.missing) {
        each(blockers, profiles, "registry_missing", "configuration");
    } else if !candidate.configured && !active.readable() {
        each(blockers, profiles, "registry_file_invalid", "configuration");
    }
    if candidate.configured && candidate.missing {
        each(blockers, profiles, "candidate_missing", "configuration");
    } else if candidate.configured && !candidate.readable() {
        each(
            blockers,
            profiles,
            "candidate_file_invalid",
            "configuration",
        );
    }
    if candidate.configured
        && registry_pin.configured
        && (!active.configured || active.missing || !active.readable() || !active.valid)
    {
        each(
            blockers,
            profiles,
            "current_registry_invalid",
            "configuration",
        );
    }
    if selected.configured && (!trust.configured || trust.missing) {
        each(blockers, profiles, "trust_store_missing", "configuration");
    } else if selected.configured && !trust.readable() {
        each(blockers, profiles, "trust_store_invalid", "configuration");
    }
    if !candidate.configured && active.readable() {
        if !registry_pin.configured || !registry_pin.valid {
            each(blockers, profiles, "registry_pin_missing", "pin_drift");
        } else if !registry_pin.matched {
            each(blockers, profiles, "registry_pin_drift", "pin_drift");
        }
    } else if candidate.configured
        && registry_pin.configured
        && (!registry_pin.valid || !registry_pin.matched)
    {
        each(blockers, profiles, "registry_pin_drift", "pin_drift");
    }
    if candidate.configured {
        if !candidate_pin.configured || !candidate_pin.valid {
            each(blockers, profiles, "candidate_pin_missing", "pin_drift");
        } else if candidate.readable() && !candidate_pin.matched {
            each(blockers, profiles, "candidate_pin_drift", "pin_drift");
        }
    }
    if trust.readable() {
        if !trust_pin.configured || !trust_pin.valid {
            each(blockers, profiles, "trust_store_pin_missing", "pin_drift");
        } else if !trust_pin.matched {
            each(blockers, profiles, "trust_store_pin_drift", "pin_drift");
        }
    }
}
fn authority(blockers: &mut Vec<Value>, profiles: &[Value], raw: &str) {
    let (code, kind) = if raw.contains("authority_spki_not_independent") {
        ("issuer_spki_not_independent", "authority_independence")
    } else if raw.contains("authority_organizations_not_independent") {
        (
            "issuer_organization_not_independent",
            "authority_independence",
        )
    } else if raw.contains("authority_signers_must_be_distinct_subjects") {
        ("issuer_subject_not_independent", "authority_independence")
    } else if raw.contains("authority_trust_store_missing_or_invalid") {
        ("trust_store_invalid", "configuration")
    } else if [
        "required_authority_role_missing",
        "signature_role_",
        "owner_mismatch",
        "observer_mismatch",
        "authorizer_mismatch",
        "verifier_identity_mismatch",
    ]
    .iter()
    .any(|v| raw.contains(v))
    {
        ("issuer_role_mismatch", "issuer_role")
    } else {
        ("signature_verification_failed", "issuer_role")
    };
    let selected = profiles.iter().find(|p| {
        let venue = p["venueId"].as_str().unwrap_or("");
        raw.starts_with(&format!("{venue}:")) || raw.contains(&format!(":{venue}"))
    });
    let evidence = EVIDENCE_TYPES
        .iter()
        .find(|e| raw.contains(&format!(":{e}:")) || raw.ends_with(&format!(":{e}")))
        .copied();
    for profile in profiles
        .iter()
        .filter(|p| selected.is_none_or(|s| s["venueId"] == p["venueId"]))
    {
        add(blockers, code, kind, profile["venueId"].as_str(), evidence);
    }
}
fn continuity(
    blockers: &mut Vec<Value>,
    profiles: &[Value],
    current: Option<&Value>,
    candidate: &Value,
) -> Result<()> {
    let mut finding = |code: &str, venue: Option<&str>| {
        let kind = if code.ends_with("_mismatch") {
            "binding_mismatch"
        } else {
            "continuity_drift"
        };
        let selected = venue.and_then(|v| profiles.iter().find(|p| p["venueId"] == v));
        for p in profiles
            .iter()
            .filter(|p| selected.is_none_or(|s| s["venueId"] == p["venueId"]))
        {
            add(blockers, code, kind, p["venueId"].as_str(), None);
        }
    };
    let revoked = array(&candidate["revokedQualificationHashes"])?;
    let Some(current) = current else {
        if candidate["generation"] != 1 {
            finding("generation_drift", None);
        }
        if !candidate["predecessorRegistryHash"].is_null() {
            finding("predecessor_drift", None);
        }
        if !revoked.is_empty() {
            finding("revocation_drift", None);
        }
        return Ok(());
    };
    if candidate["generation"].as_u64()
        != current["generation"]
            .as_u64()
            .and_then(|v| v.checked_add(1))
        || instant(&candidate["issuedAt"]) <= instant(&current["issuedAt"])
    {
        finding("generation_drift", None);
    }
    if candidate["predecessorRegistryHash"] != current["portalTargetQualificationRegistryHash"] {
        finding("predecessor_drift", None);
    }
    if revoked.iter().any(|h| {
        !entries(current)
            .iter()
            .any(|e| e["portalTargetQualificationHash"] == *h)
    }) {
        finding("revocation_drift", None);
    }
    for prior in entries(current) {
        let next = entries(candidate)
            .iter()
            .find(|e| e["venueId"] == prior["venueId"]);
        let changed = next.is_none_or(|n| {
            n["portalTargetQualificationHash"] != prior["portalTargetQualificationHash"]
        });
        let venue = prior["venueId"].as_str();
        if changed != revoked.contains(&prior["portalTargetQualificationHash"]) {
            finding("revocation_drift", venue);
        }
        if let Some(next) = next.filter(|_| changed) {
            for (field, code) in [
                ("portalTargetSubjectHash", "subject_mismatch"),
                ("submissionRouteHash", "route_mismatch"),
                ("schemaFingerprintHash", "schema_mismatch"),
            ] {
                if next[field] != prior[field] {
                    finding(code, venue);
                }
            }
        }
    }
    if entries(candidate)
        .iter()
        .any(|e| revoked.contains(&e["portalTargetQualificationHash"]))
    {
        finding("revocation_drift", None);
    }
    Ok(())
}
fn target(
    profile: &Value,
    source: &Source,
    binding: Option<&Value>,
    level: &str,
    now: i64,
    blockers: &mut Vec<Value>,
) -> Result<Value> {
    let venue = text(&profile["venueId"])?;
    let matches = entries(source.value())
        .iter()
        .enumerate()
        .filter(|(_, e)| e["venueId"] == venue)
        .collect::<Vec<_>>();
    let selected = if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    };
    let entry = selected.map(|(_, v)| v);
    let present = entry.is_some();
    let entry = entry.unwrap_or(&Value::Null);
    let mut emit = |condition: bool, code: &str, kind: &str, evidence: Option<&str>| {
        if condition {
            add(blockers, code, kind, Some(venue), evidence)
        }
    };
    emit(!present, "target_missing", "missing_evidence", None);
    emit(matches.len() > 1, "target_duplicate", "configuration", None);
    if let Some((index, _)) = selected {
        emit(
            !source
                .read
                .as_ref()
                .ok_or_else(|| error("portal_target_qualification_file_invalid"))?
                .document
                .entry_valid(index)?,
            "target_contract_invalid",
            "configuration",
            None,
        );
    }
    emit(
        present
            && (entry["liveCommitAuthorized"] != false
                || !entry["liveCommitPermitHash"].is_null()
                || entry["humanSingleUseAuthorizationRequired"] != true),
        "live_authorization_forbidden",
        "safety",
        None,
    );
    emit(
        present
            && level == "production"
            && (entry["qualificationLevel"] != "production"
                || entry["productionQualified"] != true),
        "production_qualification_missing",
        "missing_evidence",
        None,
    );
    emit(
        present && instant(&entry["qualifiedAt"]).is_some_and(|v| now < v),
        "target_not_yet_valid",
        "expiration",
        None,
    );
    emit(
        present && instant(&entry["expiresAt"]).is_some_and(|v| now >= v),
        "target_expired",
        "expiration",
        None,
    );
    let subject = if present { subject_hash(entry)? } else { None };
    emit(
        present
            && subject
                .as_ref()
                .is_none_or(|h| entry["portalTargetSubjectHash"] != *h),
        "subject_mismatch",
        "binding_mismatch",
        None,
    );
    let mut result = json!({"version":1,"kind":"PortalTargetQualificationPreflightTarget","venueId":venue,"venueKind":profile["venueKind"],"discoveryLane":profile["discoveryLane"],"connectorFamily":entry["connectorFamily"].as_str().filter(|s|!s.is_empty()).map(Value::from).unwrap_or_else(||profile["selectedConnectorFamily"].clone()),"requestedQualificationLevel":level,"overlayPresent":present,"sandboxQualified":entry["sandboxQualified"]==true,"productionQualified":entry["productionQualified"]==true,"liveCommitAuthorized":false,"liveSubmissionReady":false});
    let binding = binding.unwrap_or(&Value::Null);
    let mut invalid = false;
    for (field, name, code) in [
        ("portalTargetSubjectHash", "subject", "subject_mismatch"),
        ("submissionRouteHash", "route", "route_mismatch"),
        ("schemaFingerprintHash", "schema", "schema_mismatch"),
    ] {
        let pin = if binding[field].is_null() || binding[field] == "" {
            None
        } else {
            Some(javascript_string(&binding[field]).to_lowercase())
        };
        let configured = pin.as_deref().is_some_and(sha);
        let matched = configured && entry[field] == pin.as_deref().unwrap_or("");
        invalid |= pin.is_some() && !configured;
        emit(
            present && configured && !matched,
            code,
            "binding_mismatch",
            None,
        );
        result[format!("{name}PinConfigured")] = json!(configured);
        result[format!("{name}PinMatched")] = if configured {
            json!(matched)
        } else {
            Value::Null
        };
    }
    emit(invalid, "expected_binding_invalid", "configuration", None);
    let mut evidence = Vec::new();
    for (index, kind) in EVIDENCE_TYPES.iter().enumerate() {
        let required = level != "sandbox" || index < 3;
        let item = &entry["evidence"][*kind];
        let exists = truthy(item);
        let (role, maximum_age) =
            evidence_policy(kind).ok_or_else(|| error("portal_target_evidence_policy_missing"))?;
        emit(
            required && !exists,
            "evidence_missing",
            "missing_evidence",
            Some(kind),
        );
        if let Some((entry_index, _)) = selected {
            emit(
                exists
                    && !source
                        .read
                        .as_ref()
                        .ok_or_else(|| error("portal_target_qualification_file_invalid"))?
                        .document
                        .evidence_valid(entry_index, kind),
                "evidence_policy_mismatch",
                "binding_mismatch",
                Some(kind),
            );
        }
        emit(
            exists && subject.as_ref().is_some_and(|h| item["subjectHash"] != *h),
            "subject_mismatch",
            "binding_mismatch",
            Some(kind),
        );
        emit(
            exists && item["verifierRole"] != role,
            "issuer_role_mismatch",
            "issuer_role",
            Some(kind),
        );
        emit(
            exists && item["liveCommitPerformed"] != false,
            "live_authorization_forbidden",
            "safety",
            Some(kind),
        );
        let observed = instant(&item["observedAt"]);
        let expires = instant(&item["expiresAt"]);
        emit(
            exists && observed.is_some_and(|v| now < v),
            "evidence_not_yet_valid",
            "expiration",
            Some(kind),
        );
        emit(
            exists && expires.is_some_and(|v| now >= v),
            "evidence_expired",
            "expiration",
            Some(kind),
        );
        emit(
            exists && observed.is_some_and(|v| now.saturating_sub(v) > maximum_age),
            "evidence_stale",
            "expiration",
            Some(kind),
        );
        let current = exists
            && observed.is_some_and(|v| now >= v && now.saturating_sub(v) <= maximum_age)
            && expires.is_some_and(|v| now < v);
        evidence.push(
            json!({"evidenceType":kind,"required":required,"present":exists,"current":current}),
        );
    }
    result["evidence"] = json!(evidence);
    Ok(result)
}
pub(super) fn run(options: &PortalTargetQualificationOperatorOptionsV1) -> Result<Value> {
    let active = Source::load(options.registry_path.as_deref())?;
    let candidate = Source::load(options.candidate_path.as_deref())?;
    let trust = Source::load(options.trust_store_path.as_deref())?;
    let source = if candidate.configured {
        &candidate
    } else {
        &active
    };
    let registry_pin = Pin::new(
        options.expected_registry_hash.as_deref(),
        active.value()["portalTargetQualificationRegistryHash"].as_str(),
    );
    let candidate_pin = Pin::new(
        options.expected_candidate_file_hash.as_deref(),
        candidate.read.as_ref().map(|r| r.file_hash.as_str()),
    );
    let trust_pin = Pin::new(
        options.expected_trust_store_hash.as_deref(),
        trust.read.as_ref().map(|r| r.file_hash.as_str()),
    );
    let mut blockers = Vec::new();
    let mut profiles = Vec::new();
    let requested = options
        .target_venue_ids
        .iter()
        .map(|s| s.trim())
        .collect::<Vec<_>>();
    if !(1..=2).contains(&requested.len()) {
        add(
            &mut blockers,
            "target_count_invalid",
            "selection",
            None,
            None,
        );
    } else if requested.iter().any(|s| s.is_empty())
        || requested.iter().collect::<BTreeSet<_>>().len() != requested.len()
    {
        add(
            &mut blockers,
            "target_selection_invalid",
            "selection",
            None,
            None,
        );
    } else {
        let registry = build_journal_submission_target_registry_v1(&journal_profiles_v2()?)?;
        for venue in requested {
            if let Some(profile) = array(&registry["targets"])?
                .iter()
                .find(|p| p["venueId"] == venue)
            {
                profiles.push(profile.clone());
            } else {
                add(&mut blockers, "target_unknown", "selection", None, None);
            }
        }
    }
    let requested_level = options
        .requested_qualification_level
        .as_deref()
        .unwrap_or("production");
    let level = if ["sandbox", "production"].contains(&requested_level) {
        requested_level
    } else {
        add(&mut blockers, "level_invalid", "selection", None, None);
        "production"
    };
    if options.now_unix_ms.unsigned_abs() > 8_640_000_000_000_000 {
        add(&mut blockers, "clock_invalid", "configuration", None, None);
    }
    source_blockers(
        &mut blockers,
        &profiles,
        (&active, &candidate, &trust),
        (&registry_pin, &candidate_pin, &trust_pin),
    );
    let registry = source.value();
    if source.readable() && !source.valid {
        each(
            &mut blockers,
            &profiles,
            if candidate.configured {
                "candidate_contract_invalid"
            } else {
                "registry_contract_invalid"
            },
            "configuration",
        );
    }
    if source.readable() {
        if !registry["entries"].as_array().is_some_and(|e| e.len() <= 2)
            || registry["maximumTargetCount"] != 2
        {
            each(
                &mut blockers,
                &profiles,
                "overlay_target_limit_exceeded",
                "selection",
            );
        }
        if registry["liveCommitAuthorizationIncluded"] != false
            || registry["humanSingleUseAuthorizationRequired"] != true
        {
            each(
                &mut blockers,
                &profiles,
                "live_authorization_forbidden",
                "safety",
            );
        }
        if instant(&registry["issuedAt"]).is_some_and(|v| options.now_unix_ms < v) {
            each(
                &mut blockers,
                &profiles,
                "registry_not_yet_valid",
                "expiration",
            );
        }
        if instant(&registry["expiresAt"]).is_some_and(|v| options.now_unix_ms >= v) {
            each(&mut blockers, &profiles, "registry_expired", "expiration");
        }
    }
    if candidate.configured && source.valid {
        let selected = profiles
            .iter()
            .filter_map(|p| p["venueId"].as_str())
            .collect::<BTreeSet<_>>();
        let candidates = entries(registry)
            .iter()
            .filter_map(|p| p["venueId"].as_str())
            .collect::<BTreeSet<_>>();
        if selected != candidates {
            add(
                &mut blockers,
                "candidate_target_set_mismatch",
                "selection",
                None,
                None,
            );
        }
    }
    if let Some(trust) = &trust.read {
        for selected in [Some(source), candidate.configured.then_some(&active)]
            .into_iter()
            .flatten()
            .filter(|s| s.valid)
        {
            for raw in selected
                .read
                .as_ref()
                .ok_or_else(|| error("portal_target_qualification_file_invalid"))?
                .document
                .authority_blockers(&trust.document)
            {
                authority(&mut blockers, &profiles, &raw);
            }
        }
    }
    if candidate.configured && candidate.valid {
        continuity(
            &mut blockers,
            &profiles,
            active.valid.then(|| active.value()),
            candidate.value(),
        )?;
    }
    let mut targets = Vec::new();
    for profile in &profiles {
        targets.push(target(
            profile,
            source,
            options
                .expected_target_bindings
                .get(text(&profile["venueId"])?),
            level,
            options.now_unix_ms,
            &mut blockers,
        )?);
    }
    let collation = ProductionCollationV1::load()
        .map_err(|_| error("portal_target_qualification_collation_failed"))?;
    blockers.sort_by(|a, b| {
        for field in ["targetVenueId", "evidenceType", "errorCode"] {
            let cmp = collation.compare(
                a[field].as_str().unwrap_or(""),
                b[field].as_str().unwrap_or(""),
            );
            if !cmp.is_eq() {
                return cmp;
            }
        }
        std::cmp::Ordering::Equal
    });
    blockers.dedup();
    let global = blockers.iter().any(|b| b["targetVenueId"].is_null());
    for target in &mut targets {
        let local = blockers
            .iter()
            .filter(|b| b["targetVenueId"] == target["venueId"])
            .cloned()
            .collect::<Vec<_>>();
        let recognized = !global && local.is_empty();
        let sandbox = target["sandboxQualified"] == true;
        let production = target["productionQualified"] == true;
        target["sandboxQualified"] = json!(!candidate.configured && recognized && sandbox);
        target["productionQualified"] = json!(!candidate.configured && recognized && production);
        target["candidateSandboxQualificationVerified"] =
            json!(candidate.configured && recognized && sandbox);
        target["candidateProductionQualificationVerified"] =
            json!(candidate.configured && recognized && production);
        target["blockers"] = json!(local);
    }
    let ready = blockers.is_empty() && (1..=2).contains(&targets.len()) && source.valid;
    let source_pin = if candidate.configured {
        &candidate_pin
    } else {
        &registry_pin
    };
    let mut report = json!({"version":1,"kind":"PortalTargetQualificationPreflightPlan","status":if ready{"portal_target_qualification_preflight_ready"}else{"portal_target_qualification_preflight_blocked"},"ready":ready,"source":if candidate.configured{"candidate_registry"}else{"active_registry"},"requestedQualificationLevel":level,"selectedTargetCount":targets.len(),
        "registry":{"activeConfigured":active.configured,"candidateConfigured":candidate.configured,"sourceReadable":source.readable(),"sourceContractValid":source.valid,"sourcePinConfigured":source_pin.configured && source_pin.valid,"sourcePinMatched":source_pin.matched,"trustStoreConfigured":trust.configured,"trustStoreReadable":trust.readable(),"trustStorePinConfigured":trust_pin.configured && trust_pin.valid,"trustStorePinMatched":trust_pin.matched,"generation":if source.valid{registry["generation"].clone()}else{Value::Null},"overlayTargetCount":if source.valid{entries(registry).len()}else{0},"maximumTargetCount":2,"liveCommitAuthorizationIncluded":false,"humanSingleUseAuthorizationRequired":true},"targets":targets,"blockers":blockers,
        "safety":{"readOnly":true,"mutationPerformed":false,"registryProduced":false,"evidenceProduced":false,"networkActionPerformed":false,"credentialUsed":false,"portalLoginPerformed":false,"uploadPerformed":false,"signatureProduced":false,"authorizationProduced":false,"liveCommitAuthorized":false,"liveCommitPermitProduced":false,"liveCommitPermitConsumed":false}});
    report["preflightPlanHash"] = json!(hash("PortalTargetQualificationPreflightPlan", &report)?);
    for snapshot in [&active, &candidate, &trust]
        .iter()
        .filter_map(|s| s.read.as_ref())
    {
        snapshot.assert_current()?;
    }
    Ok(report)
}
