//! Rebuild the fixed numerical qualification contracts and use the incumbent
//! Ed25519 authority owner. A verified local chain is not an activation permit.
use super::*;
use crate::journal_connector_coverage::qualification_authority::{
    AuthorityVerification, verify_numerical_qualification_authority_v2,
};
use base64ct::{Base64, Encoding};
use unicode_normalization::UnicodeNormalization;
pub(super) const ROLES: [&str; 4] = [
    "advanced_numerical_oracle_authority",
    "advanced_numerical_replay_authority",
    "advanced_numerical_scientific_reviewer",
    "advanced_numerical_uncertainty_reviewer",
];
const PLUGIN_ROLE: &str = "advanced_numerical_plugin_authority";
const LIFETIME: i64 = 366 * 86_400_000;
const AGE: i64 = 31 * 86_400_000;
fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn instant(v: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(v.as_str()?)
}
fn window(v: &Value) -> bool {
    match (
        instant(&v["signedAt"]),
        instant(&v["validFrom"]),
        instant(&v["expiresAt"]),
    ) {
        (Some(s), Some(f), Some(e)) => {
            s <= f && f < e && e.checked_sub(s).is_some_and(|n| n <= LIFETIME)
        }
        _ => false,
    }
}
fn signature_shape(v: &Value) -> bool {
    exact(v, &["algorithm", "keyId", "role", "value"])
        && v["algorithm"] == "ed25519"
        && v["keyId"].as_str().is_some_and(|s| !s.is_empty())
        && v["role"].as_str().is_some_and(|s| !s.is_empty())
        && Base64::decode_vec(string(&v["value"])).is_ok_and(|bytes| {
            bytes.len() == 64 && Base64::encode_string(&bytes) == string(&v["value"])
        })
}
fn identity(v: &Value, descriptor: &Value, bundle: &str) -> bool {
    v["version"] == 1
        && v["pluginId"] == descriptor["pluginId"]
        && v["pluginVersion"] == descriptor["pluginVersion"]
        && v["analysisFamily"] == descriptor["analysisFamily"]
        && v["descriptorHash"] == descriptor["advancedNumericalPluginDescriptorHash"]
        && v["signedBundleHash"] == bundle
}
fn digest_matches(
    v: &Value,
    kind: &str,
    member: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    check(c, d)?;
    let Some(map) = v.as_object() else {
        return Ok(false);
    };
    let payload = Json::Object(
        map.iter()
            .filter(|(k, _)| k.as_str() != member && k.as_str() != "signatures")
            .map(|(k, v)| Ok((k.encode_utf16().collect(), json_value(v)?)))
            .collect::<Result<Vec<_>, String>>()?,
    );
    Ok(sha(string(&v[member])) && v[member] == hash(kind, &payload, c)?)
}
fn statement(
    v: &Value,
    descriptor: &Value,
    bundle: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    check(c, d)?;
    const EVIDENCE: &[&str] = &[
        "independentNumericOracleReceiptHash",
        "referenceExecutionReceiptHash",
        "referenceResultHash",
        "replayExecutionReceiptHash",
        "replayResultHash",
        "scientificReviewReceiptHash",
        "typedUncertaintyReviewReceiptHash",
    ];
    if !exact(
        v,
        &[
            "advancedNumericalPluginQualificationStatementHash",
            "analysisFamily",
            "descriptorHash",
            "evidence",
            "expiresAt",
            "kind",
            "pluginId",
            "pluginVersion",
            "signatures",
            "signedAt",
            "signedBundleHash",
            "status",
            "validFrom",
            "version",
        ],
    ) || !identity(v, descriptor, bundle)
        || v["kind"] != "AdvancedNumericalPluginQualificationStatement"
        || v["status"] != "advanced_numerical_plugin_production_qualification_approved"
        || !window(v)
        || !exact(&v["evidence"], EVIDENCE)
        || EVIDENCE.iter().any(|k| !sha(string(&v["evidence"][*k])))
        || v["evidence"]["referenceExecutionReceiptHash"]
            == v["evidence"]["replayExecutionReceiptHash"]
        || v["evidence"]["referenceResultHash"] != v["evidence"]["replayResultHash"]
        || !v["signatures"]
            .as_array()
            .is_some_and(|a| a.len() == 4 && a.iter().all(signature_shape))
    {
        return Ok(false);
    }
    digest_matches(
        v,
        "AdvancedNumericalPluginQualificationStatement",
        "advancedNumericalPluginQualificationStatementHash",
        c,
        d,
    )
}
fn receipt(
    v: &Value,
    descriptor: &Value,
    bundle: &str,
    label: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    check(c, d)?;
    let (kind, status, member, extra): (&str, &str, &str, &[&str]) = match label {
        "reference_execution" | "replay_execution" => (
            "AdvancedNumericalQualificationExecutionReceipt",
            "advanced_numerical_qualification_execution_completed",
            "advancedNumericalQualificationExecutionReceiptHash",
            &[
                "executedAt",
                "executionMode",
                "executionProcessIdentityHash",
                "requestCorpusHash",
                "resultHash",
                "runtimeExecutableHash",
                "runtimePackageClosureHash",
                "sourceMerkleHash",
                "sourceWorkspaceManifestHash",
            ],
        ),
        "numeric_oracle" => (
            "AdvancedNumericalOracleQualificationReceipt",
            "advanced_numerical_oracle_qualification_approved",
            "advancedNumericalOracleQualificationReceiptHash",
            &[
                "independentNumericOracleArtifactHash",
                "oracleAccepted",
                "oracleContractHash",
                "referenceExecutionReceiptHash",
                "replayExecutionReceiptHash",
                "resultHash",
            ],
        ),
        "typed_uncertainty_review" => (
            "AdvancedNumericalUncertaintyQualificationReceipt",
            "advanced_numerical_uncertainty_qualification_approved",
            "advancedNumericalUncertaintyQualificationReceiptHash",
            &[
                "typedUncertaintyAccepted",
                "typedUncertaintyArtifactHash",
                "uncertaintyContractHash",
                "referenceExecutionReceiptHash",
                "replayExecutionReceiptHash",
                "resultHash",
            ],
        ),
        "scientific_review" => (
            "AdvancedNumericalScientificReviewQualificationReceipt",
            "advanced_numerical_scientific_review_approved",
            "advancedNumericalScientificReviewQualificationReceiptHash",
            &[
                "approved",
                "independentNumericOracleReceiptHash",
                "typedUncertaintyReviewReceiptHash",
                "scientificReviewArtifactHash",
                "referenceExecutionReceiptHash",
                "replayExecutionReceiptHash",
                "resultHash",
            ],
        ),
        _ => return Err("advanced_numerical_qualification_receipt_kind_invalid".into()),
    };
    let mut keys = vec![
        "analysisFamily",
        "descriptorHash",
        "expiresAt",
        "kind",
        "pluginId",
        "pluginVersion",
        "signatures",
        "signedAt",
        "signedBundleHash",
        "status",
        "validFrom",
        "version",
        member,
    ];
    keys.extend_from_slice(extra);
    if !exact(v, &keys)
        || !identity(v, descriptor, bundle)
        || v["kind"] != kind
        || v["status"] != status
        || !window(v)
        || !v["signatures"]
            .as_array()
            .is_some_and(|a| a.len() == 1 && a.iter().all(signature_shape))
    {
        return Ok(false);
    }
    for key in extra {
        check(c, d)?;
        if key.ends_with("Hash") && !sha(string(&v[*key])) {
            return Ok(false);
        }
    }
    match label {
        "reference_execution" | "replay_execution" => {
            if v["executionMode"]
                != if label == "reference_execution" {
                    "reference"
                } else {
                    "independent-replay"
                }
                || instant(&v["executedAt"])
                    .is_none_or(|t| instant(&v["signedAt"]).is_none_or(|s| t > s))
                || v["runtimeExecutableHash"] != descriptor["runtime"]["executableHash"]
                || v["runtimePackageClosureHash"] != descriptor["runtime"]["packageClosureHash"]
                || v["sourceMerkleHash"] != descriptor["sourceIdentity"]["merkleHash"]
                || v["sourceWorkspaceManifestHash"]
                    != descriptor["sourceIdentity"]["workspaceManifestHash"]
            {
                return Ok(false);
            }
        }
        "numeric_oracle" => {
            if v["oracleAccepted"] != true
                || v["oracleContractHash"]
                    != descriptor["assuranceContracts"]["oracle"]["contractHash"]
            {
                return Ok(false);
            }
        }
        "typed_uncertainty_review" => {
            if v["typedUncertaintyAccepted"] != true
                || v["uncertaintyContractHash"]
                    != descriptor["assuranceContracts"]["uncertainty"]["contractHash"]
            {
                return Ok(false);
            }
        }
        "scientific_review" => {
            if v["approved"] != true {
                return Ok(false);
            }
        }
        _ => return Ok(false),
    }
    digest_matches(v, kind, member, c, d)
}
const SPECS: [(&str, &str, &str, &str); 5] = [
    (
        "reference_execution",
        "referenceExecutionReceipt",
        PLUGIN_ROLE,
        "advancedNumericalQualificationExecutionReceiptHash",
    ),
    (
        "replay_execution",
        "replayExecutionReceipt",
        "advanced_numerical_replay_authority",
        "advancedNumericalQualificationExecutionReceiptHash",
    ),
    (
        "numeric_oracle",
        "independentNumericOracleReceipt",
        "advanced_numerical_oracle_authority",
        "advancedNumericalOracleQualificationReceiptHash",
    ),
    (
        "typed_uncertainty_review",
        "typedUncertaintyReviewReceipt",
        "advanced_numerical_uncertainty_reviewer",
        "advancedNumericalUncertaintyQualificationReceiptHash",
    ),
    (
        "scientific_review",
        "scientificReviewReceipt",
        "advanced_numerical_scientific_reviewer",
        "advancedNumericalScientificReviewQualificationReceiptHash",
    ),
];
fn evidence(
    v: &Value,
    q: &Value,
    descriptor: &Value,
    bundle: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    // The original evidence verifier first validates the bound statement,
    // before it can admit or inspect any of the five evidence authorities.
    if !statement(q, descriptor, bundle, c, d)? {
        return Ok(false);
    }
    if !exact(
        v,
        &[
            "advancedNumericalPluginQualificationEvidenceBundleHash",
            "analysisFamily",
            "descriptorHash",
            "independentNumericOracleReceipt",
            "kind",
            "pluginId",
            "pluginVersion",
            "qualificationStatementHash",
            "referenceExecutionReceipt",
            "replayExecutionReceipt",
            "scientificReviewReceipt",
            "signedBundleHash",
            "status",
            "typedUncertaintyReviewReceipt",
            "version",
        ],
    ) || !identity(v, descriptor, bundle)
        || v["kind"] != "AdvancedNumericalPluginQualificationEvidenceBundle"
        || v["status"] != "advanced_numerical_plugin_qualification_evidence_complete"
        || v["qualificationStatementHash"] != q["advancedNumericalPluginQualificationStatementHash"]
    {
        return Ok(false);
    }
    for (label, key, _, _) in SPECS {
        if !receipt(&v[key], descriptor, bundle, label, c, d)? {
            return Ok(false);
        }
    }
    let r = &v["referenceExecutionReceipt"];
    let p = &v["replayExecutionReceipt"];
    let rh = &r["advancedNumericalQualificationExecutionReceiptHash"];
    let ph = &p["advancedNumericalQualificationExecutionReceiptHash"];
    let oh =
        &v["independentNumericOracleReceipt"]["advancedNumericalOracleQualificationReceiptHash"];
    let uh =
        &v["typedUncertaintyReviewReceipt"]["advancedNumericalUncertaintyQualificationReceiptHash"];
    let sh =
        &v["scientificReviewReceipt"]["advancedNumericalScientificReviewQualificationReceiptHash"];
    let result = &r["resultHash"];
    if rh == ph
        || r["executionProcessIdentityHash"] == p["executionProcessIdentityHash"]
        || r["requestCorpusHash"] != p["requestCorpusHash"]
        || result != &p["resultHash"]
    {
        return Ok(false);
    }
    for name in [
        "independentNumericOracleReceipt",
        "typedUncertaintyReviewReceipt",
        "scientificReviewReceipt",
    ] {
        if &v[name]["referenceExecutionReceiptHash"] != rh
            || &v[name]["replayExecutionReceiptHash"] != ph
            || &v[name]["resultHash"] != result
        {
            return Ok(false);
        }
    }
    if &v["scientificReviewReceipt"]["independentNumericOracleReceiptHash"] != oh
        || &v["scientificReviewReceipt"]["typedUncertaintyReviewReceiptHash"] != uh
        || &q["evidence"]["independentNumericOracleReceiptHash"] != oh
        || &q["evidence"]["referenceExecutionReceiptHash"] != rh
        || &q["evidence"]["referenceResultHash"] != result
        || &q["evidence"]["replayExecutionReceiptHash"] != ph
        || &q["evidence"]["replayResultHash"] != result
        || &q["evidence"]["scientificReviewReceiptHash"] != sh
        || &q["evidence"]["typedUncertaintyReviewReceiptHash"] != uh
    {
        return Ok(false);
    }
    digest_matches(
        v,
        "AdvancedNumericalPluginQualificationEvidenceBundle",
        "advancedNumericalPluginQualificationEvidenceBundleHash",
        c,
        d,
    )
}
fn time_blockers(v: &Value, now: i64) -> Vec<String> {
    let mut out = Vec::new();
    let s = instant(&v["signedAt"]);
    let f = if crate::native_business::local_submission_preflight::local_submission_truthy(
        &v["validFrom"],
    ) {
        instant(&v["validFrom"])
    } else {
        s
    };
    let e = instant(&v["expiresAt"]);
    if s.is_none() {
        out.push("authority_signed_at_invalid".into())
    }
    if f.is_none() {
        out.push("authority_valid_from_invalid".into())
    }
    if e.is_none() {
        out.push("authority_expires_at_invalid".into())
    }
    if f.is_some_and(|f| now < f) {
        out.push("authority_not_yet_valid".into())
    }
    if e.is_some_and(|e| now >= e) {
        out.push("authority_expired".into())
    }
    if s.zip(e).is_some_and(|(s, e)| e <= s) {
        out.push("authority_expiry_not_after_signature".into())
    }
    if s.zip(e)
        .is_some_and(|(s, e)| e.checked_sub(s).is_none_or(|n| n > LIFETIME))
    {
        out.push("authority_lifetime_exceeds_policy".into())
    }
    out
}
type ControlIdentities = (Vec<String>, Vec<String>, Vec<String>);
fn control_identities(
    a: &AuthorityVerification,
    c: &AtomicBool,
    d: Instant,
) -> Result<ControlIdentities, String> {
    let mut orgs = Vec::new();
    let mut keys = Vec::new();
    let mut blockers = Vec::new();
    for signature in &a.signatures {
        check(c, d)?;
        let org = &signature.value["organization"];
        // JSON documents use the incumbent coercion owner. Exotic receivers
        // are refused by its existing boundary, never granted an identity.
        let raw =
            if crate::native_business::local_submission_preflight::local_submission_truthy(org) {
                crate::native_research_claims::raw_string(org)?
            } else {
                String::new()
            };
        let mut normalized = String::new();
        for ch in raw.nfkc() {
            check(c, d)?;
            if normalized.len() + ch.len_utf8() > 64 * 1024 {
                return Err("advanced_numerical_qualification_organization_limit_exceeded".into());
            }
            normalized.push(ch)
        }
        let org = normalized
            .split(|ch: char| {
                let mut b = [0u8; 4];
                crate::automation_runtime_reconciliation::sqlite_number::trim(
                    ch.encode_utf8(&mut b),
                )
                .is_empty()
            })
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if org.is_empty() {
            blockers.push("advanced_numerical_authority_organization_required".into());
            continue;
        }
        orgs.push(org);
        keys.push(signature.spki.clone());
    }
    orgs.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    keys.sort();
    Ok((orgs, keys, blockers))
}
fn verify(
    document: &Value,
    trust: &Value,
    roles: &[&str],
    c: &AtomicBool,
    d: Instant,
) -> Result<AuthorityVerification, String> {
    verify_numerical_qualification_authority_v2(document, trust, roles, c, d)
}
pub(super) struct QualificationInputs {
    pub descriptor: Value,
    pub bundle_hash: String,
    pub plugin_authority: Value,
    pub plugin_trust: Value,
    pub statement: Value,
    pub evidence: Value,
    pub trust: Value,
}
impl QualificationInputs {
    pub(super) fn inspect(&self, c: &AtomicBool, d: Instant) -> Result<Json, String> {
        let now = i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "advanced_numerical_qualification_clock_unavailable")?
                .as_millis(),
        )
        .map_err(|_| "advanced_numerical_qualification_clock_unavailable")?;
        self.inspect_at(now, c, d)
    }
    fn inspect_at(&self, now: i64, c: &AtomicBool, d: Instant) -> Result<Json, String> {
        check(c, d)?;
        crate::native_business::local_submission_preflight::local_submission_values_budget_v1([
            &self.descriptor,
            &self.plugin_authority,
            &self.plugin_trust,
            &self.statement,
            &self.evidence,
            &self.trust,
        ])?;
        let descriptor = &self.descriptor;
        let q = &self.statement;
        let e = &self.evidence;
        let mut blockers = Vec::new();
        if !statement(q, descriptor, &self.bundle_hash, c, d)? {
            blockers.push("advanced_numerical_plugin_qualification_statement_invalid".into())
        }
        blockers.extend(time_blockers(q, now));
        let qualified = verify(q, &self.trust, &ROLES, c, d)?;
        blockers.extend(qualified.blockers.iter().cloned());
        let plugin = verify(
            &self.plugin_authority,
            &self.plugin_trust,
            &[PLUGIN_ROLE],
            c,
            d,
        )?;
        let plugin_subjects = plugin.report["verifiedSubjectIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !plugin.blockers.is_empty() || plugin_subjects.len() != 1 || plugin.signatures.len() != 1
        {
            blockers.push("advanced_numerical_plugin_authority_verification_required".into())
        }
        if qualified
            .signatures
            .iter()
            .any(|s| plugin_subjects.contains(&s.value["subjectId"]))
        {
            blockers.push(
                "advanced_numerical_plugin_qualification_subject_independence_required".into(),
            )
        }
        let (po, pk, pb) = control_identities(&plugin, c, d)?;
        let (qo, qk, qb) = control_identities(&qualified, c, d)?;
        blockers.extend(pb);
        blockers.extend(qb);
        if po.len() + qo.len() != 5 || po.iter().chain(&qo).collect::<BTreeSet<_>>().len() != 5 {
            blockers.push(
                "advanced_numerical_plugin_qualification_organization_independence_required".into(),
            )
        }
        if pk.len() + qk.len() != 5 || pk.iter().chain(&qk).collect::<BTreeSet<_>>().len() != 5 {
            blockers.push(
                "advanced_numerical_plugin_qualification_public_key_independence_required".into(),
            )
        }
        let ev = evidence(e, q, descriptor, &self.bundle_hash, c, d)?;
        if !ev {
            blockers.push("advanced_numerical_plugin_qualification_evidence_bundle_invalid".into())
        }
        if ev {
            for (label, key, role, _) in SPECS {
                check(c, d)?;
                let receipt = &e[key];
                let trust = if role == PLUGIN_ROLE {
                    &self.plugin_trust
                } else {
                    &self.trust
                };
                blockers.extend(
                    time_blockers(receipt, now)
                        .into_iter()
                        .map(|b| format!("{label}:{b}")),
                );
                let auth = verify(receipt, trust, &[role], c, d)?;
                blockers.extend(auth.blockers.iter().map(|b| format!("{label}:{b}")));
                let signed = instant(&q["signedAt"]);
                let expires = instant(&q["expiresAt"]);
                let evidence_instant = if receipt.get("executedAt").is_some() {
                    instant(&receipt["executedAt"])
                } else {
                    instant(&receipt["signedAt"])
                };
                if signed
                    .zip(evidence_instant)
                    .is_none_or(|(q, e)| e > q || q.checked_sub(e).is_none_or(|age| age > AGE))
                {
                    blockers.push(format!(
                        "{label}:advanced_numerical_qualification_evidence_not_current"
                    ))
                }
                if signed
                    .zip(instant(&receipt["signedAt"]))
                    .is_none_or(|(q, e)| e > q)
                {
                    blockers.push(format!(
                        "{label}:advanced_numerical_qualification_evidence_signed_after_statement"
                    ))
                }
                if expires
                    .zip(instant(&receipt["expiresAt"]))
                    .is_none_or(|(q, e)| e < q)
                {
                    blockers.push(format!("{label}:advanced_numerical_qualification_evidence_expiry_not_covering_statement"))
                }
                let subjects = auth.report["verifiedSubjectIds"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                if subjects.len() != 1 {
                    blockers.push(format!(
                        "advanced_numerical_{label}_single_authority_subject_required"
                    ));
                    continue;
                }
                if role == PLUGIN_ROLE {
                    if !plugin_subjects.contains(&subjects[0]) {
                        blockers.push("advanced_numerical_reference_execution_plugin_authority_binding_invalid".into())
                    }
                } else if qualified
                    .signatures
                    .iter()
                    .rfind(|s| s.value["role"] == role)
                    .map(|s| &s.value["subjectId"])
                    != Some(&subjects[0])
                {
                    blockers.push(format!(
                        "advanced_numerical_{label}_statement_authority_binding_invalid"
                    ))
                }
            }
        }
        if !blockers.is_empty() {
            blockers.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            blockers.dedup();
            return Err(format!(
                "advanced_numerical_plugin_production_qualification_invalid:{}",
                blockers.join(",")
            ));
        }
        let mut qs = qualified.report["verifiedSubjectIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        qs.sort_by(|a, b| string(a).encode_utf16().cmp(string(b).encode_utf16()));
        let qr = qualified.report["verifiedRoles"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let strings = |v: &[String]| Json::Array(v.iter().map(|s| text(s)).collect());
        let payload = object([
            (
                "version",
                Json::Number(if descriptor["version"] == 2 { 3.0 } else { 2.0 }),
            ),
            (
                "kind",
                text("AdvancedNumericalPluginProductionQualificationInspection"),
            ),
            (
                "status",
                text("advanced_numerical_plugin_production_qualified"),
            ),
            ("productionQualified", Json::Bool(true)),
            ("pluginId", json_value(&descriptor["pluginId"])?),
            ("pluginVersion", json_value(&descriptor["pluginVersion"])?),
            ("analysisFamily", json_value(&descriptor["analysisFamily"])?),
            (
                "descriptorHash",
                json_value(&descriptor["advancedNumericalPluginDescriptorHash"])?,
            ),
            ("signedBundleHash", text(&self.bundle_hash)),
            (
                "qualificationStatementHash",
                json_value(&q["advancedNumericalPluginQualificationStatementHash"])?,
            ),
            (
                "qualificationEvidenceBundleHash",
                json_value(&e["advancedNumericalPluginQualificationEvidenceBundleHash"])?,
            ),
            (
                "pluginAuthoritySubjectIds",
                json_value(&Value::Array(plugin_subjects))?,
            ),
            ("pluginAuthorityOrganizations", strings(&po)),
            ("pluginAuthorityPublicKeySpkiHashes", strings(&pk)),
            (
                "qualificationAuthoritySubjectIds",
                json_value(&Value::Array(qs))?,
            ),
            ("qualificationAuthorityOrganizations", strings(&qo)),
            ("qualificationAuthorityPublicKeySpkiHashes", strings(&qk)),
            (
                "qualificationAuthorityRoles",
                json_value(&Value::Array(qr.to_vec()))?,
            ),
            ("signedAt", json_value(&q["signedAt"])?),
            ("validFrom", json_value(&q["validFrom"])?),
            ("expiresAt", json_value(&q["expiresAt"])?),
            (
                "requestCorpusHash",
                json_value(&e["referenceExecutionReceipt"]["requestCorpusHash"])?,
            ),
            (
                "resultHash",
                json_value(&e["referenceExecutionReceipt"]["resultHash"])?,
            ),
            (
                "referenceExecutionProcessIdentityHash",
                json_value(&e["referenceExecutionReceipt"]["executionProcessIdentityHash"])?,
            ),
            (
                "replayExecutionProcessIdentityHash",
                json_value(&e["replayExecutionReceipt"]["executionProcessIdentityHash"])?,
            ),
            (
                "evidenceReceiptHashes",
                object([
                    (
                        "independentNumericOracleReceiptHash",
                        json_value(
                            &e["independentNumericOracleReceipt"]["advancedNumericalOracleQualificationReceiptHash"],
                        )?,
                    ),
                    (
                        "referenceExecutionReceiptHash",
                        json_value(
                            &e["referenceExecutionReceipt"]["advancedNumericalQualificationExecutionReceiptHash"],
                        )?,
                    ),
                    (
                        "replayExecutionReceiptHash",
                        json_value(
                            &e["replayExecutionReceipt"]["advancedNumericalQualificationExecutionReceiptHash"],
                        )?,
                    ),
                    (
                        "scientificReviewReceiptHash",
                        json_value(
                            &e["scientificReviewReceipt"]["advancedNumericalScientificReviewQualificationReceiptHash"],
                        )?,
                    ),
                    (
                        "typedUncertaintyReviewReceiptHash",
                        json_value(
                            &e["typedUncertaintyReviewReceipt"]["advancedNumericalUncertaintyQualificationReceiptHash"],
                        )?,
                    ),
                ]),
            ),
        ]);
        let payload = if descriptor["version"] == 2 {
            let authority = descriptor::gpu_authority_v2(descriptor, c, d)?;
            let Json::Object(mut fields) = payload else {
                return Err("advanced_numerical_plugin_qualification_inspection_invalid".into());
            };
            let at = fields
                .iter()
                .position(|(key, _)| {
                    key.iter()
                        .copied()
                        .eq("evidenceReceiptHashes".encode_utf16())
                })
                .ok_or("advanced_numerical_plugin_qualification_inspection_invalid")?;
            fields.splice(
                at..at,
                [
                    (
                        "gpuRuntimeAuthority".encode_utf16().collect(),
                        authority.clone(),
                    ),
                    (
                        "gpuRuntimeAuthorityHash".encode_utf16().collect(),
                        field(&authority, "advancedNumericalGpuRuntimeAuthorityHash").clone(),
                    ),
                ],
            );
            Json::Object(fields)
        } else {
            payload
        };
        let digest = hash(
            "AdvancedNumericalPluginProductionQualificationInspection",
            &payload,
            c,
        )?;
        let Json::Object(mut fields) = payload else {
            return Err("advanced_numerical_qualification_inspection_invalid".into());
        };
        fields.push((
            "advancedNumericalPluginProductionQualificationInspectionHash"
                .encode_utf16()
                .collect(),
            text(&digest),
        ));
        check(c, d)?;
        Ok(Json::Object(fields))
    }
}
#[cfg(test)]
mod tests;
