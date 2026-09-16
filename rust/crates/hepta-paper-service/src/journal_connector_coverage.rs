//! Native journal connector discovery coverage and its read-only CLI projection.
//!
//! Profiles are data, imported from the version 2 journal dataset. Target/family
//! registries, dispositions, hashes, filtering and gates are computed in Rust.
//! No Node process is used at runtime. Signed registry inspection validates
//! pinned local evidence and independent Ed25519 authorities. Neither discovery
//! nor verified qualification can become live submission authority.

pub mod qualification;
mod qualification_authority;
mod qualification_json;

use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{0}")]
pub struct JournalConnectorCoverageError(pub String);

type Result<T> = std::result::Result<T, JournalConnectorCoverageError>;

fn error(message: impl Into<String>) -> JournalConnectorCoverageError {
    JournalConnectorCoverageError(message.into())
}

fn record(kind: &str, field: &str, mut payload: Value) -> Result<Value> {
    let hash = production_hash_record_v1(kind, &payload)
        .map_err(|_| error("journal_submission_connector_coverage_hash_failed"))?;
    payload[field] = json!(hash.as_str());
    Ok(payload)
}

fn sort_by_field(values: &mut [Value], field: &str) -> Result<()> {
    let collation = ProductionCollationV1::load()
        .map_err(|_| error("journal_submission_connector_coverage_collation_failed"))?;
    values.sort_by(|left, right| {
        collation.compare(
            left[field].as_str().unwrap_or_default(),
            right[field].as_str().unwrap_or_default(),
        )
    });
    Ok(())
}

/// The complete input dataset, not precomputed coverage or readiness results.
pub fn journal_profiles_v2() -> Result<Value> {
    serde_json::from_str(include_str!("data/journal-profiles.v2.json"))
        .map_err(|_| error("journal_submission_target_profiles_required"))
}

const CAPABILITIES: &[&str] = &[
    "commit",
    "createDraft",
    "discoverProfile",
    "dryRun",
    "fillMetadata",
    "getReceipt",
    "getStatus",
    "preview",
    "reconcile",
    "uploadAssets",
    "validate",
];
const FULL_API: &[&str] = &[
    "discoverProfile",
    "validate",
    "createDraft",
    "uploadAssets",
    "fillMetadata",
    "preview",
    "commit",
    "getReceipt",
    "getStatus",
    "reconcile",
];

struct Family {
    id: &'static str,
    transport: &'static str,
    implementation: &'static str,
    authentication: &'static [&'static str],
    schema: &'static str,
    receipt: &'static str,
    browser: bool,
    commit: bool,
    capabilities: &'static [&'static str],
    dry_run: bool,
}

/// Build every connector family from the same source policy fields as Node.
pub fn build_submission_connector_family_registry_v1() -> Result<Value> {
    let definitions = [
        Family {
            id: "openreview-api-v2",
            transport: "official-api",
            implementation: "prototype-adapter-present",
            authentication: &["api-token", "isolated-session"],
            schema: "dynamic-invitation-schema",
            receipt: "independent-signed-connector-attestation-required",
            browser: false,
            commit: true,
            capabilities: FULL_API,
            dry_run: false,
        },
        Family {
            id: "hotcrp-rest-v1",
            transport: "official-api",
            implementation: "prototype-adapter-present",
            authentication: &["bearer-token"],
            schema: "edition-openapi-plus-settings-discovery",
            receipt: "independent-signed-connector-attestation-required",
            browser: false,
            commit: true,
            capabilities: FULL_API,
            dry_run: true,
        },
        Family {
            id: "ojs-rest-v1",
            transport: "official-api",
            implementation: "prototype-adapter-present",
            authentication: &["api-token"],
            schema: "instance-version-plus-workflow-schema",
            receipt: "independent-signed-connector-attestation-required",
            browser: false,
            commit: true,
            capabilities: FULL_API,
            dry_run: true,
        },
        Family {
            id: "scholarone-submission-integration-v1",
            transport: "official-partner-integration",
            implementation: "publisher-authorization-required",
            authentication: &["partner-s3-credential", "partner-client-key"],
            schema: "journal-authorized-go-jats-package-profile",
            receipt: "partner-notification-plus-independent-attestation",
            browser: false,
            commit: true,
            capabilities: FULL_API,
            dry_run: false,
        },
        Family {
            id: "arxiv-sword-v1",
            transport: "official-authorized-api",
            implementation: "platform-authorization-required",
            authentication: &["authorized-sword-account"],
            schema: "sword-collection-service-document",
            receipt: "provider-receipt-plus-independent-attestation",
            browser: false,
            commit: true,
            capabilities: FULL_API,
            dry_run: false,
        },
        Family {
            id: "playwright-assisted-draft-v1",
            transport: "browser-assisted",
            implementation: "prototype-adapter-present",
            authentication: &["human-session-handoff"],
            schema: "versioned-dom-fingerprint-and-semantic-selectors",
            receipt: "independent-execution-attestation",
            browser: true,
            commit: false,
            capabilities: &[
                "discoverProfile",
                "validate",
                "createDraft",
                "uploadAssets",
                "fillMetadata",
                "preview",
                "getStatus",
                "reconcile",
            ],
            dry_run: false,
        },
        Family {
            id: "manual-handoff-v1",
            transport: "human-operated",
            implementation: "manual-only",
            authentication: &["human-session"],
            schema: "operator-reviewed-checklist",
            receipt: "human-supplied-provider-evidence",
            browser: false,
            commit: false,
            capabilities: &[
                "validate",
                "preview",
                "getReceipt",
                "getStatus",
                "reconcile",
            ],
            dry_run: false,
        },
        Family {
            id: "portal-schema-discovery-required-v1",
            transport: "none",
            implementation: "discovery-required",
            authentication: &[],
            schema: "no-binding-until-evidence-backed-discovery",
            receipt: "unavailable",
            browser: false,
            commit: false,
            capabilities: &[],
            dry_run: false,
        },
    ];
    let mut families = definitions
        .iter()
        .map(|family| {
            let capabilities: BTreeMap<&str, bool> = CAPABILITIES
                .iter()
                .map(|key| {
                    (
                        *key,
                        family.capabilities.contains(key) || (*key == "dryRun" && family.dry_run),
                    )
                })
                .collect();
            record(
                "SubmissionConnectorFamily",
                "submissionConnectorFamilyHash",
                json!({
                    "version": 1, "kind": "SubmissionConnectorFamily", "connectorFamily": family.id,
                    "transport": family.transport, "implementationStatus": family.implementation,
                    "authenticationModes": family.authentication, "schemaStrategy": family.schema,
                    "receiptAuthority": family.receipt, "browserAutomation": family.browser,
                    "finalCommitSupported": family.commit, "capabilities": capabilities,
                    "credentialIsolationRequired": true, "humanFinalReviewRequired": true,
                    "unknownDeclarationsBlockCommit": true, "blindCommitRetryPermitted": false,
                    "captchaBypassPermitted": false, "productionQualified": false,
                }),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    sort_by_field(&mut families, "connectorFamily")?;
    record(
        "SubmissionConnectorFamilyRegistry",
        "submissionConnectorFamilyRegistryHash",
        json!({
            "version": 1, "kind": "SubmissionConnectorFamilyRegistry",
            "status": "submission_connector_family_registry_ready", "familyCount": families.len(),
            "prototypeAdapterFamilyCount": families.iter().filter(|v| v["implementationStatus"] == "prototype-adapter-present").count(),
            "productionQualifiedFamilyCount": count(&families, "productionQualified"), "families": families,
        }),
    )
}

struct Routing {
    lane: &'static str,
    ids: &'static [&'static str],
    candidates: &'static [&'static str],
    prototype: bool,
}
const BROWSER_MANUAL: &[&str] = &["playwright-assisted-draft-v1", "manual-handoff-v1"];
const SCHOLARONE: &[&str] = &[
    "scholarone-submission-integration-v1",
    "playwright-assisted-draft-v1",
    "manual-handoff-v1",
];
const ROUTING: &[Routing] = &[
    Routing {
        lane: "openreview-current-prototype",
        ids: &["iclr", "icml", "neurips", "tmlr"],
        candidates: &["openreview-api-v2"],
        prototype: true,
    },
    Routing {
        lane: "conference-openreview-candidate",
        ids: &[
            "acl", "cvpr", "eccv", "emnlp", "iccv", "kdd", "naacl", "rss", "sigmod", "www",
        ],
        candidates: &[
            "openreview-api-v2",
            "playwright-assisted-draft-v1",
            "manual-handoff-v1",
        ],
        prototype: false,
    },
    Routing {
        lane: "conference-hotcrp-candidate",
        ids: &[
            "asplos",
            "ccs",
            "focs",
            "fse",
            "ieee_sp",
            "isca",
            "micro",
            "ndss",
            "nsdi",
            "osdi",
            "pldi",
            "popl",
            "sigcomm",
            "soda",
            "sosp",
            "stoc",
            "usenix_security",
        ],
        candidates: &[
            "hotcrp-rest-v1",
            "playwright-assisted-draft-v1",
            "manual-handoff-v1",
        ],
        prototype: false,
    },
    Routing {
        lane: "conference-cmt-candidate",
        ids: &["icse", "vldb"],
        candidates: BROWSER_MANUAL,
        prototype: false,
    },
    Routing {
        lane: "conference-pcs-candidate",
        ids: &["chi", "uist"],
        candidates: BROWSER_MANUAL,
        prototype: false,
    },
    Routing {
        lane: "conference-linklings-candidate",
        ids: &["siggraph"],
        candidates: BROWSER_MANUAL,
        prototype: false,
    },
    Routing {
        lane: "conference-papercept-candidate",
        ids: &["icra"],
        candidates: BROWSER_MANUAL,
        prototype: false,
    },
    Routing {
        lane: "conference-platform-discovery",
        ids: &["alt", "colt"],
        candidates: BROWSER_MANUAL,
        prototype: false,
    },
    Routing {
        lane: "journal-scholarone-organization-candidate",
        ids: &[
            "informs_joc",
            "isr",
            "jacm",
            "management_science",
            "marketing_science",
            "moor",
            "msom",
            "operations_research",
            "organization_science",
            "sicomp",
            "siam_optimization",
            "taco",
            "tdsc",
            "tochi",
            "tocs",
            "toga",
            "tois",
            "toplas",
            "tpami",
            "tro",
            "tse",
            "ieee_tac",
        ],
        candidates: SCHOLARONE,
        prototype: false,
    },
    Routing {
        lane: "journal-oup-scholarone-candidate",
        ids: &["biometrika", "jcr", "jrssb", "qje", "restud", "rfs"],
        candidates: SCHOLARONE,
        prototype: false,
    },
    Routing {
        lane: "journal-scholarone-candidate",
        ids: &[
            "amj",
            "amr",
            "asq",
            "ijrr",
            "jasa",
            "jmr",
            "journal_marketing",
            "misq",
        ],
        candidates: SCHOLARONE,
        prototype: false,
    },
    Routing {
        lane: "journal-editorial-manager-candidate",
        ids: &["automatica", "jae", "jfe"],
        candidates: BROWSER_MANUAL,
        prototype: false,
    },
    Routing {
        lane: "journal-independent-platform-discovery",
        ids: &[
            "aer",
            "annals_math",
            "aos",
            "econometrica",
            "jmlr",
            "nature",
            "nature_machine_intelligence",
            "science",
        ],
        candidates: &[
            "ojs-rest-v1",
            "playwright-assisted-draft-v1",
            "manual-handoff-v1",
        ],
        prototype: false,
    },
    Routing {
        lane: "journal-platform-migration-discovery",
        ids: &[
            "accounting_review",
            "acta_math",
            "inventiones",
            "jams",
            "jar",
            "jibs",
            "jom",
            "journal_finance",
            "jpe",
            "pom",
            "smj",
            "tacl",
        ],
        candidates: &[
            "scholarone-submission-integration-v1",
            "ojs-rest-v1",
            "playwright-assisted-draft-v1",
            "manual-handoff-v1",
        ],
        prototype: false,
    },
];

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(_) | Value::Number(_) => value.to_string(),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn target(profile: &Value, families: &[Value]) -> Result<Value> {
    if !truthy(&profile["id"])
        || !truthy(&profile["label"])
        || !matches!(profile["kind"].as_str(), Some("conference" | "journal"))
    {
        return Err(error("journal_submission_target_profile_invalid"));
    }
    let id = profile["id"].as_str().unwrap_or_default();
    let route = ROUTING
        .iter()
        .find(|route| route.ids.contains(&id))
        .ok_or_else(|| {
            error(format!(
                "journal_submission_target_routing_missing:{}",
                js_string(&profile["id"])
            ))
        })?;
    let prototype_available = route.candidates.iter().any(|candidate| {
        families.iter().any(|family| {
            family["connectorFamily"] == *candidate
                && family["implementationStatus"] == "prototype-adapter-present"
        })
    });
    let conference = profile["kind"] == "conference";
    let mut blockers = Vec::new();
    if conference {
        blockers.push("venue_edition_cycle_and_track_binding_required");
    }
    blockers.extend([
        "submission_portal_binding_evidence_required",
        "submission_terms_and_automation_policy_evidence_required",
        "submission_schema_snapshot_required",
        "submission_authentication_profile_required",
    ]);
    if !prototype_available {
        blockers.push("submission_connector_implementation_required");
    } else if !route.prototype {
        blockers.push("submission_target_adapter_profile_required");
    }
    blockers.extend([
        "independent_connector_execution_attestation_required",
        "submission_live_no_side_effect_canary_required",
        "final_commit_human_review_and_single_use_permit_required",
    ]);
    let profile_hash = production_hash_record_v1("JournalProfileSnapshot", profile)
        .map_err(|_| error("journal_submission_connector_coverage_hash_failed"))?;
    record(
        "JournalSubmissionTargetProfile",
        "journalSubmissionTargetProfileHash",
        json!({
            "version": 1, "kind": "JournalSubmissionTargetProfile", "venueId": profile["id"],
            "venueLabel": profile["label"], "venueKind": profile["kind"], "journalProfileHash": profile_hash.as_str(),
            "identityStatus": "stable-venue-identity-known", "targetInstanceStatus": if conference { "edition-cycle-track-unbound" } else { "journal-instance-unbound" },
            "discoveryLane": route.lane, "candidateConnectorFamilies": route.candidates,
            "selectedConnectorFamily": if route.prototype { "openreview-api-v2" } else { "portal-schema-discovery-required-v1" },
            "portalBindingStatus": "unverified", "schemaStatus": "unverified", "automationPolicyStatus": "unverified", "authenticationProfileStatus": "unverified",
            "connectorFamilyPrototypeAvailable": prototype_available, "prototypeAdapterPresent": route.prototype,
            "adapterImplemented": route.prototype, "sandboxQualified": false, "productionQualified": false,
            "liveCommitAuthorized": false, "liveSubmissionReady": false, "finalCommitRequiresHumanReview": true,
            "unknownDeclarationsBlockCommit": true, "blindCommitRetryPermitted": false, "discoveryRequired": true, "blockers": blockers,
        }),
    )
}

fn count(entries: &[Value], field: &str) -> usize {
    entries.iter().filter(|value| truthy(&value[field])).count()
}

fn add_counts(payload: &mut Value, entries: &[Value], fields: &[&str]) {
    for field in fields {
        payload[format!("{field}Count")] = json!(count(entries, field));
    }
}

/// Rebuild all target profiles; custom profile input obeys legacy identity and orphan checks.
pub fn build_journal_submission_target_registry_v1(profiles: &Value) -> Result<Value> {
    let profiles = profiles
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("journal_submission_target_profiles_required"))?;
    let mut identities = BTreeSet::new();
    // JSON objects/arrays are distinct JavaScript Set identities, even when their
    // values are equal. They pass this check and fail the routing lookup later.
    if profiles.iter().any(|profile| {
        !truthy(&profile["id"])
            || (!(profile["id"].is_object() || profile["id"].is_array())
                && !identities.insert(profile["id"].to_string()))
    }) {
        return Err(error("journal_submission_target_profile_identity_invalid"));
    }
    let mut orphans = ROUTING
        .iter()
        .flat_map(|route| route.ids.iter())
        .filter(|id| !profiles.iter().any(|profile| profile["id"] == **id))
        .copied()
        .collect::<Vec<_>>();
    orphans.sort_unstable();
    if !orphans.is_empty() {
        return Err(error(format!(
            "journal_submission_target_routing_orphan:{}",
            orphans.join(",")
        )));
    }
    let families = build_submission_connector_family_registry_v1()?;
    let family_entries = families["families"]
        .as_array()
        .ok_or_else(|| error("submission_connector_family_registry_invalid"))?;
    let mut targets = profiles
        .iter()
        .map(|profile| target(profile, family_entries))
        .collect::<Result<Vec<_>>>()?;
    sort_by_field(&mut targets, "venueId")?;
    let mut payload = json!({
        "version": 1, "kind": "JournalSubmissionTargetRegistry", "status": "journal_submission_targets_discovery_required",
        "journalProfileCount": profiles.len(), "targetProfileCount": targets.len(),
        "conferenceTargetCount": targets.iter().filter(|v| v["venueKind"] == "conference").count(),
        "journalTargetCount": targets.iter().filter(|v| v["venueKind"] == "journal").count(),
        "conferenceConnectorFamilyPrototypeAvailableCount": targets.iter().filter(|v| v["venueKind"] == "conference" && v["connectorFamilyPrototypeAvailable"] == true).count(),
        "journalConnectorFamilyPrototypeAvailableCount": targets.iter().filter(|v| v["venueKind"] == "journal" && v["connectorFamilyPrototypeAvailable"] == true).count(),
        "silentFallbackPermitted": false,
    });
    add_counts(
        &mut payload,
        &targets,
        &[
            "connectorFamilyPrototypeAvailable",
            "prototypeAdapterPresent",
            "sandboxQualified",
            "productionQualified",
            "liveCommitAuthorized",
            "liveSubmissionReady",
            "discoveryRequired",
        ],
    );
    payload["targets"] = json!(targets);
    record(
        "JournalSubmissionTargetRegistry",
        "journalSubmissionTargetRegistryHash",
        payload,
    )
}

fn coverage_entry(target: &Value) -> Result<Value> {
    let prototype = target["prototypeAdapterPresent"] == true;
    let mut payload = json!({
        "version": 2, "kind": "JournalSubmissionConnectorCoverageEntry",
        "connectorFamily": target["selectedConnectorFamily"],
        "connectorDisposition": if prototype { "prototype_adapter_present_target_binding_unverified" }
            else if target["identityStatus"] == "composite-identity-blocked" { "venue_identity_split_required" }
            else if target["connectorFamilyPrototypeAvailable"] == true { "connector_family_prototype_present_target_profile_required" }
            else { "platform_binding_and_connector_required" },
        "identityKnown": target["identityStatus"] == "stable-venue-identity-known",
        "targetProfileResolved": target["portalBindingStatus"] == "verified",
        "implementationReady": target["adapterImplemented"],
    });
    for field in [
        "venueId",
        "venueLabel",
        "venueKind",
        "journalSubmissionTargetProfileHash",
        "discoveryLane",
        "candidateConnectorFamilies",
        "connectorFamilyPrototypeAvailable",
        "prototypeAdapterPresent",
        "adapterImplemented",
        "sandboxQualified",
        "productionQualified",
        "liveCommitAuthorized",
        "liveSubmissionReady",
        "discoveryRequired",
        "finalCommitRequiresHumanReview",
        "blindCommitRetryPermitted",
        "blockers",
    ] {
        payload[field] = target[field].clone();
    }
    record(
        "JournalSubmissionConnectorCoverageEntry",
        "journalSubmissionConnectorCoverageEntryHash",
        payload,
    )
}

const COVERAGE_COUNTS: &[&str] = &[
    "identityKnown",
    "targetProfileResolved",
    "connectorFamilyPrototypeAvailable",
    "prototypeAdapterPresent",
    "adapterImplemented",
    "sandboxQualified",
    "productionQualified",
    "liveCommitAuthorized",
    "liveSubmissionReady",
    "discoveryRequired",
];

pub fn build_journal_connector_coverage_v2(profiles: &Value) -> Result<Value> {
    let registry = build_journal_submission_target_registry_v1(profiles)?;
    let targets = registry["targets"]
        .as_array()
        .ok_or_else(|| error("journal_submission_target_registry_invalid"))?;
    let profile_count = profiles
        .as_array()
        .ok_or_else(|| error("journal_submission_target_profiles_required"))?
        .len();
    let entries = targets
        .iter()
        .map(coverage_entry)
        .collect::<Result<Vec<_>>>()?;
    let families = build_submission_connector_family_registry_v1()?;
    let mut payload = json!({
        "version": 2, "kind": "JournalSubmissionConnectorCoverage", "status": "journal_submission_connectors_incomplete",
        "journalProfileCount": profile_count, "dispositionCount": entries.len(),
        "connectorFamilyRegistryHash": families["submissionConnectorFamilyRegistryHash"],
        "targetRegistryHash": registry["journalSubmissionTargetRegistryHash"],
        "journalConnectorFamilyPrototypeAvailableCount": journal_prototypes(&entries), "silentFallbackPermitted": false,
    });
    add_counts(&mut payload, &entries, COVERAGE_COUNTS);
    add_counts(&mut payload, &entries, &["implementationReady"]);
    payload["entries"] = json!(entries);
    record(
        "JournalSubmissionConnectorCoverage",
        "journalSubmissionConnectorCoverageHash",
        payload,
    )
}

fn journal_prototypes(entries: &[Value]) -> usize {
    entries
        .iter()
        .filter(|v| v["venueKind"] == "journal" && v["connectorFamilyPrototypeAvailable"] == true)
        .count()
}

const GATES: &[(&str, &str)] = &[
    (
        "require-family-prototype",
        "connectorFamilyPrototypeAvailable",
    ),
    ("require-profile-resolved", "targetProfileResolved"),
    ("require-adapter-implemented", "adapterImplemented"),
    ("require-sandbox-qualified", "sandboxQualified"),
    ("require-production-qualified", "productionQualified"),
    ("require-live-ready", "liveSubmissionReady"),
];
const VALUE_FLAGS: &[&str] = &[
    "kind",
    "qualification-registry",
    "qualification-registry-hash",
    "qualification-trust-store",
    "qualification-trust-store-hash",
    "venue",
];

fn parse_arguments(argv: &[String]) -> Result<BTreeMap<String, String>> {
    let mut args = BTreeMap::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--" {
            return Err(error("unexpected_cli_argument_separator"));
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| error(format!("unexpected_cli_positional:{token}")))?;
        let (key, inline) = match raw.split_once('=') {
            Some((k, v)) => (k, Some(v)),
            None => (raw, None),
        };
        if key.is_empty() {
            return Err(error("empty_cli_option"));
        }
        let boolean =
            key == "help" || key == "summary" || GATES.iter().any(|(flag, _)| *flag == key);
        let value = if boolean {
            if inline.is_some() {
                return Err(error(format!(
                    "boolean_cli_option_does_not_take_value:--{key}"
                )));
            }
            "true"
        } else {
            if !VALUE_FLAGS.contains(&key) {
                return Err(error(format!("unknown_cli_option:--{key}")));
            }
            let value = if let Some(value) = inline {
                value
            } else {
                index += 1;
                argv.get(index)
                    .filter(|v| !v.starts_with("--"))
                    .ok_or_else(|| error(format!("missing_cli_option_value:--{key}")))?
            };
            if value.is_empty() {
                return Err(error(format!("empty_cli_option_value:--{key}")));
            }
            value
        };
        if args.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(error(format!("duplicate_cli_option:--{key}")));
        }
        index += 1;
    }
    Ok(args)
}

/// The JSON stdout value and exit status are separate because legacy gates print
/// the report even when they set status 1. Errors are returned before stdout.
#[derive(Debug)]
pub struct JournalConnectorCoverageOutputV2 {
    pub value: Value,
    pub exit_code: i32,
}

/// Read-only command semantics. Pass the actual process environment in the CLI;
/// injecting it here makes tests independent of the developer's credentials.
pub fn journal_connector_coverage_cli_v2(
    argv: &[String],
    environment: &BTreeMap<String, String>,
) -> Result<JournalConnectorCoverageOutputV2> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error("portal_target_qualification_clock_invalid"))?;
    let now = i64::try_from(now.as_millis())
        .map_err(|_| error("portal_target_qualification_clock_invalid"))?;
    journal_connector_coverage_cli_at_v2(argv, environment, now)
}

/// Deterministic clock entry point for differential and expiry-boundary tests.
pub fn journal_connector_coverage_cli_at_v2(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    now_unix_ms: i64,
) -> Result<JournalConnectorCoverageOutputV2> {
    let args = parse_arguments(argv)?;
    if args.contains_key("help") {
        return Ok(JournalConnectorCoverageOutputV2 {
            value: json!({
                "version": 2, "kind": "JournalConnectorCoverageUsage",
                "usage": "journal-connector-coverage [--summary] [--kind journal|conference] [--venue <venue-id>] [--require-family-prototype] [--require-profile-resolved] [--require-adapter-implemented] [--require-sandbox-qualified] [--require-production-qualified] [--require-live-ready] [--qualification-registry PATH] --qualification-registry-hash sha256:... [--qualification-trust-store PATH --qualification-trust-store-hash sha256:...]",
                "mutation": "read-only", "externalAction": false,
            }),
            exit_code: 0,
        });
    }
    let mut coverage = build_journal_connector_coverage_v2(&journal_profiles_v2()?)?;
    let mut qualification_inspection = None;
    if let Some(registry_path) = args
        .get("qualification-registry")
        .or_else(|| environment.get("HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY"))
        .filter(|path| !path.is_empty())
    {
        let selected = |flag: &str, variable: &str| {
            args.get(flag)
                .or_else(|| environment.get(variable))
                .map(String::as_str)
                .filter(|value| !value.is_empty())
        };
        let inspection = qualification::inspect_portal_target_qualification_registry_v1(
            qualification::PortalTargetQualificationOptionsV1 {
                registry_path: std::path::Path::new(registry_path),
                trust_store_path: selected(
                    "qualification-trust-store",
                    "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE",
                )
                .map(std::path::Path::new),
                expected_registry_hash: selected(
                    "qualification-registry-hash",
                    "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH",
                ),
                expected_trust_store_hash: selected(
                    "qualification-trust-store-hash",
                    "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH",
                ),
                now_unix_ms,
            },
        )?;
        if !inspection.ready() {
            let blockers = inspection.report()["blockers"]
                .as_array()
                .ok_or_else(|| error("portal_target_qualification_inspection_invalid"))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| error("portal_target_qualification_inspection_invalid"))
                })
                .collect::<Result<Vec<_>>>()?;
            return Err(error(format!(
                "portal_target_qualification_registry_blocked:{}",
                blockers.join(",")
            )));
        }
        coverage = qualification::apply_inspected_portal_target_qualifications_v1(
            &coverage,
            &inspection,
            now_unix_ms,
        )?;
        qualification_inspection = Some(inspection);
    }
    if let Some(kind) = args.get("kind")
        && !["conference", "journal"].contains(&kind.as_str())
    {
        return Err(error(format!(
            "journal_submission_connector_coverage_kind_invalid:{kind}"
        )));
    }
    let mut entries = coverage["entries"]
        .as_array()
        .ok_or_else(|| error("journal_submission_connector_coverage_entries_required"))?
        .clone();
    if let Some(venue) = args.get("venue") {
        entries.retain(|entry| entry["venueId"] == *venue);
        if entries.len() != 1 {
            return Err(error(format!(
                "journal_submission_connector_coverage_unknown_venue:{venue}"
            )));
        }
    }
    if let Some(kind) = args.get("kind") {
        entries.retain(|entry| entry["venueKind"] == *kind);
        if let Some(venue) = args.get("venue")
            && entries.len() != 1
        {
            return Err(error(format!(
                "journal_submission_connector_coverage_venue_kind_mismatch:{venue}:{kind}"
            )));
        }
    }
    let mut summary = json!({
        "version": 2, "kind": "JournalConnectorCoverageSummary", "selectedVenueCount": entries.len(),
        "journalConnectorFamilyPrototypeAvailableCount": journal_prototypes(&entries),
        "portalTargetQualificationRegistryHash": null, "qualificationGeneration": null, "qualificationExpiresAt": null,
        "humanSingleUseAuthorizationRequired": true,
    });
    if let Some(inspection) = qualification_inspection {
        summary["portalTargetQualificationRegistryHash"] =
            inspection.report()["registryHash"].clone();
        summary["qualificationGeneration"] = inspection.report()["generation"].clone();
        summary["qualificationExpiresAt"] = inspection.report()["expiresAt"].clone();
    }
    add_counts(&mut summary, &entries, COVERAGE_COUNTS);
    let failed_gate = GATES.iter().any(|(flag, field)| {
        args.contains_key(*flag) && entries.iter().any(|entry| entry[*field] != true)
    });
    if !args.contains_key("summary") {
        summary["entries"] = json!(entries);
    }
    Ok(JournalConnectorCoverageOutputV2 {
        value: summary,
        exit_code: i32::from(failed_gate),
    })
}
