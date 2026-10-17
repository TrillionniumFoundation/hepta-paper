//! Bounded compatibility metadata for the incumbent `automation-status` route.
//!
//! The incumbent route performs a large readiness query with optional provider,
//! formal-sandbox, release-attestor and handoff effects.  This module deliberately
//! exposes only its deterministic help contract.  It never reads a store,
//! contacts an authority, probes a provider, or claims readiness.

#![forbid(unsafe_code)]

/// Exact JSON emitted by `node paper-core/bin/automation-status.mjs --help`.
pub const AUTOMATION_STATUS_HELP_JSON_V1: &str = r#"{
  "version": 2,
  "kind": "AutomationStatusUsage",
  "usage": "automation-status [--json] [--handoff] [--deployment-environment-file PATH] [--root PATH] [--runtime-root PATH] [--require-full-research] [--require-fully-autonomous] [--live-formal-sandbox-probe] [--live-provider-canary] [--live-release-attestor]",
  "mutation": "formal probe qualification receipt only with --live-formal-sandbox-probe",
  "localObservationEffects": "runtime-metadata-and-daemon-probes-may-change",
  "externalAction": "argument-dependent"
}"#;

#[must_use]
pub fn automation_status_help_json_v1() -> &'static str {
    AUTOMATION_STATUS_HELP_JSON_V1
}
