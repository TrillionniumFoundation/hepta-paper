use super::*;
#[derive(Debug)]
pub struct PortalTargetQualificationCliOutputV1 {
    pub report: Value,
    pub exit_code: i32,
}
const VALUE_FLAGS: &[&str] = &[
    "action",
    "candidate",
    "candidate-hash",
    "plan-hash",
    "qualification-level",
    "registry",
    "registry-hash",
    "trust-store",
    "trust-store-hash",
];
const REPEATABLE: &[&str] = &[
    "expected-route-hash",
    "expected-schema-hash",
    "expected-subject-hash",
    "target",
];
fn usage() -> Value {
    json!({"version":1,"kind":"PortalTargetQualificationUsage","usage":([
        "portal-target-qualification --action status --registry PATH",
        "--trust-store PATH --trust-store-hash sha256:... [--registry-hash sha256:...]",
        "portal-target-qualification --action preflight --target VENUE [--target VENUE]",
        "[--qualification-level sandbox|production] [the status or import-plan pins]",
        "portal-target-qualification --action import-plan --registry PATH",
        "--candidate PATH --candidate-hash sha256:... --trust-store PATH",
        "--trust-store-hash sha256:...",
        "portal-target-qualification --action import-execute --execute",
        "--plan-hash sha256:... <the same import-plan arguments>"].join(" ")),
        "environmentDefaults":{"registry":"HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY","registryHash":"HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH","trustStore":"HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE","trustStoreHash":"HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH"},
        "constraints":[
            "Registry entries contain typed, independently signed, expiring, non-fixture evidence attestations for at most two targets.",
            "Ready status requires the exact semantic registry hash; successor generations bind predecessor and explicit revocation hashes.",
            "Import-plan and status are read-only; import-execute performs one local atomic registry write.",
            "Preflight is a read-only redacted lint for exactly one or two selected discovery targets.",
            "No action performs a portal request, uses credentials, or creates or consumes a live commit permit.",
            "Final commit always requires a separate human-reviewed single-use authorization."]})
}
/// Original strict flags, repeatable expected bindings, environment defaults and
/// report-before-status-2 gates. The caller supplies the clock and environment.
pub fn portal_target_qualification_cli_at_v1(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    now_unix_ms: i64,
) -> Result<PortalTargetQualificationCliOutputV1> {
    let mut values = BTreeMap::<String, String>::new();
    let mut repeated = BTreeMap::<String, Vec<String>>::new();
    let mut flags = std::collections::BTreeSet::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        index += 1;
        if token == "--" {
            return Err(error("unexpected_cli_argument_separator"));
        }
        let Some(raw) = token.strip_prefix("--") else {
            return Err(error(format!("unexpected_cli_positional:{token}")));
        };
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(k, v)| (k, Some(v)));
        if key.is_empty() {
            return Err(error("empty_cli_option"));
        }
        if ["execute", "help", "require-ready"].contains(&key) {
            if inline.is_some() {
                return Err(error(format!(
                    "boolean_cli_option_does_not_take_value:--{key}"
                )));
            }
            if !flags.insert(key.to_owned()) {
                return Err(error(format!("duplicate_cli_option:--{key}")));
            }
            continue;
        }
        if !VALUE_FLAGS.contains(&key) && !REPEATABLE.contains(&key) {
            return Err(error(format!("unknown_cli_option:--{key}")));
        }
        let value = if let Some(value) = inline {
            value.to_owned()
        } else {
            let next = argv
                .get(index)
                .filter(|next| !next.starts_with("--"))
                .ok_or_else(|| error(format!("missing_cli_option_value:--{key}")))?;
            index += 1;
            next.clone()
        };
        if value.is_empty() {
            return Err(error(format!("empty_cli_option_value:--{key}")));
        }
        if REPEATABLE.contains(&key) {
            repeated.entry(key.to_owned()).or_default().push(value);
        } else if values.insert(key.to_owned(), value).is_some() {
            return Err(error(format!("duplicate_cli_option:--{key}")));
        }
    }
    if flags.contains("help") {
        return Ok(PortalTargetQualificationCliOutputV1 {
            report: usage(),
            exit_code: 0,
        });
    }
    let action = values.get("action").map(String::as_str).unwrap_or("status");
    if !["status", "preflight", "import-plan", "import-execute"].contains(&action) {
        return Err(error(format!(
            "portal_target_qualification_action_invalid:{action}"
        )));
    }
    let selected = |flag: &str, env: &str| {
        values
            .get(flag)
            .or_else(|| environment.get(env).filter(|value| !value.is_empty()))
            .cloned()
    };
    let mut options = PortalTargetQualificationOperatorOptionsV1 {
        registry_path: selected("registry", "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY")
            .map(PathBuf::from),
        trust_store_path: selected(
            "trust-store",
            "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE",
        )
        .map(PathBuf::from),
        expected_registry_hash: selected(
            "registry-hash",
            "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH",
        ),
        expected_trust_store_hash: selected(
            "trust-store-hash",
            "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH",
        ),
        candidate_path: values.get("candidate").map(PathBuf::from),
        expected_candidate_file_hash: values.get("candidate-hash").cloned(),
        expected_plan_hash: values.get("plan-hash").cloned(),
        target_venue_ids: repeated.get("target").cloned().unwrap_or_default(),
        requested_qualification_level: values.get("qualification-level").cloned(),
        now_unix_ms,
        ..Default::default()
    };
    if action == "preflight" {
        for (flag, field) in [
            ("expected-subject-hash", "portalTargetSubjectHash"),
            ("expected-route-hash", "submissionRouteHash"),
            ("expected-schema-hash", "schemaFingerprintHash"),
        ] {
            for specification in repeated.get(flag).into_iter().flatten() {
                let (venue, value) = specification.split_once('=').ok_or_else(|| {
                    error("portal_target_qualification_preflight_binding_argument_invalid")
                })?;
                if venue.is_empty()
                    || value.is_empty()
                    || !options
                        .target_venue_ids
                        .iter()
                        .any(|target| target == venue)
                {
                    return Err(error(
                        "portal_target_qualification_preflight_binding_argument_invalid",
                    ));
                }
                let binding = options
                    .expected_target_bindings
                    .entry(venue.into())
                    .or_insert_with(|| json!({"venueId":venue}));
                if binding.get(field).is_some() {
                    return Err(error(
                        "portal_target_qualification_preflight_binding_argument_duplicate",
                    ));
                }
                binding[field] = json!(value);
            }
        }
    }
    let report = match action {
        "status" => inspect_portal_target_qualification_v1(&options)?,
        "preflight" => preflight_portal_target_qualification_v1(&options)?,
        "import-plan" => plan_portal_target_qualification_import_v1(&options)?,
        _ => {
            if !flags.contains("execute") {
                return Err(error(
                    "portal_target_qualification_import_execute_confirmation_required",
                ));
            }
            execute_portal_target_qualification_import_v1(&options)?
        }
    };
    let exit_code = if ["status", "preflight"].contains(&action)
        && flags.contains("require-ready")
        && report["ready"] != true
    {
        2
    } else {
        0
    };
    Ok(PortalTargetQualificationCliOutputV1 { report, exit_code })
}
