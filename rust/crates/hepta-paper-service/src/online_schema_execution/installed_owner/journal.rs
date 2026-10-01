//! Durable installed execution intent, separate from kernel progress. The exact
//! requests are saved before external RPC/restart effects; unknown results retain
//! all barriers and replay selected requests without lease renewal.
use super::*;
use crate::{
    online_schema_execution::plan::installation_support::validate_schema_transition_plan_identity_v1,
    sqlite_mutation_coordinator::{
        authority::files::{Snapshot, parse},
        hash, hash_bytes, keys, timestamp,
    },
    state_recoverability::publication::{Directory, publish_receipt},
};
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
};
const NAME: &str = "EXECUTION.v1.json";
const MAXIMUM_BYTES: u64 = 4 * 1024 * 1024;
const PHASES: [&str; 8] = [
    "reservation_pending",
    "normalization_pending",
    "installation_pending",
    "finalization_pending",
    "target_restart_pending",
    "observation_pending",
    "publication_pending",
    "completed",
];
const KEYS_V1: &[&str] = &[
    "version",
    "kind",
    "runtimeRoot",
    "transitionId",
    "planHash",
    "profileSha256",
    "sourceAuthorityConfigurationHash",
    "plan",
    "reserveRequest",
    "reserveRequestHash",
    "phase",
    "checkedAtMillis",
    "finalizationRequestHash",
    "observationRequestHash",
    "targetRestartRequestHash",
    "finalReceiptFileSha256",
    "finalizationRequest",
    "observationRequest",
    "targetRestartRequest",
    "previousFinalReceiptFileSha256",
];
const KEYS_V2_EXTRA: &[&str] = &[
    "bootstrapDispatchState",
    "reserveDispatchState",
    "originalManagerFileSha256",
    "rollbackState",
];
const ROLLBACK_STATES: [&str; 4] = [
    "not_selected",
    "control_restore_pending",
    "writer_resume_pending",
    "completed",
];
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_installed_schema_execution_journal_invalid_or_changed")
}
pub(crate) struct ExecutionJournalV1 {
    directory: Directory,
    observed: Snapshot,
    value: Value,
    hash: String,
}
impl ExecutionJournalV1 {
    fn load(
        directory: Directory,
        operation: &SchemaOperationIdentityV1,
        source_hash: &str,
    ) -> Result<Self> {
        let (value, observed, digest) = read(&directory)?;
        let v2 = value["version"] == 2;
        let expected_keys = if v2 {
            KEYS_V1
                .iter()
                .chain(KEYS_V2_EXTRA)
                .copied()
                .collect::<Vec<_>>()
        } else {
            KEYS_V1.to_vec()
        };
        if !keys(&value, &expected_keys)
            || (!v2 && value["version"] != 1)
            || value["kind"]
                != if v2 {
                    "HeptaInstalledSchemaExecutionIntentV2"
                } else {
                    "HeptaInstalledSchemaExecutionIntentV1"
                }
            || value["runtimeRoot"] != json!(operation.runtime_root)
            || value["transitionId"] != operation.transition_id
            || value["planHash"] != operation.plan_hash
            || value["profileSha256"] != operation.profile_sha256
            || value["sourceAuthorityConfigurationHash"] != source_hash
            || value["plan"]["transitionId"] != operation.transition_id
            || value["plan"]["planHash"] != operation.plan_hash
            || !PHASES.iter().any(|phase| value["phase"] == *phase)
            || value["checkedAtMillis"].as_i64().is_none_or(|v| v < 0)
            || value["reserveRequestHash"]
                != hash(
                    "AutonomousResearchOnlineSchemaTransitionReserveRequest",
                    &value["reserveRequest"],
                )?
        {
            return Err(invalid());
        }
        if v2 {
            validate_v2_boundary(&value)?;
        }
        validate_schema_transition_plan_identity_v1(&value["plan"])?;
        let mut expected = value["plan"].clone();
        let object = expected.as_object_mut().ok_or_else(invalid)?;
        object.remove("planHash");
        object.remove("plannedAt");
        object.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineSchemaTransitionReserveRequest"),
        );
        object.insert(
            "requestedAt".into(),
            value["reserveRequest"]["requestedAt"].clone(),
        );
        if expected != value["reserveRequest"]
            || timestamp(&value["reserveRequest"]["requestedAt"])
                .zip(timestamp(&value["plan"]["plannedAt"]))
                .is_none_or(|(requested, planned)| requested < planned)
            || [
                "finalizationRequestHash",
                "observationRequestHash",
                "targetRestartRequestHash",
                "finalReceiptFileSha256",
            ]
            .iter()
            .any(|key| !value[key].is_null() && !sha(&value[key]))
            || (!value["previousFinalReceiptFileSha256"].is_null()
                && !sha(&value["previousFinalReceiptFileSha256"]))
        {
            return Err(invalid());
        }
        for (request, digest, domain) in REQUESTS {
            if value[request].is_null() != value[digest].is_null()
                || (!value[request].is_null() && hash(domain, &value[request])? != value[digest])
            {
                return Err(invalid());
            }
        }
        let result = Self {
            directory,
            observed,
            value,
            hash: digest,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub(crate) fn begin(
        operation: &SchemaOperationIdentityV1,
        plan: &Value,
        request: &Value,
        source_hash: &str,
        previous_final_pin: Option<&str>,
        now: i64,
    ) -> Result<Self> {
        let directory = Directory::open_or_create(&operation.barrier_root.join("execution"), true)?;
        match fs::symlink_metadata(directory.path.join(NAME)) {
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
            _ => {
                return Err(error(
                    "autonomous_research_installed_schema_execution_recovery_required",
                ));
            }
        }
        let value = json!({"version":2,"kind":"HeptaInstalledSchemaExecutionIntentV2","bootstrapDispatchState":"never-dispatched","reserveDispatchState":"never-dispatched","originalManagerFileSha256":null,"rollbackState":"not_selected","runtimeRoot":operation.runtime_root,"transitionId":operation.transition_id,"planHash":operation.plan_hash,"profileSha256":operation.profile_sha256,"sourceAuthorityConfigurationHash":source_hash,"plan":plan,"reserveRequest":request,"reserveRequestHash":hash("AutonomousResearchOnlineSchemaTransitionReserveRequest",request)?,"phase":"reservation_pending","checkedAtMillis":now,"finalizationRequestHash":null,"observationRequestHash":null,"targetRestartRequestHash":null,"finalReceiptFileSha256":null,"finalizationRequest":null,"observationRequest":null,"targetRestartRequest":null,"previousFinalReceiptFileSha256":previous_final_pin});
        publish_receipt(&directory, NAME, &value, None)?;
        Self::load(directory, operation, source_hash)
    }
    pub(crate) fn recover(
        operation: &SchemaOperationIdentityV1,
        source_hash: &str,
    ) -> Result<Self> {
        Self::load(
            Directory::open_or_create(&operation.barrier_root.join("execution"), false)?,
            operation,
            source_hash,
        )
    }
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        self.observed.assert_current()?;
        Ok(())
    }
    pub(crate) fn record_original_manager(&mut self, digest: &str, now: i64) -> Result<()> {
        if self.value["version"] != 2
            || !sha(&json!(digest))
            || self.value["rollbackState"] != "not_selected"
            || self.value["bootstrapDispatchState"] != "never-dispatched"
            || self.value["reserveDispatchState"] != "never-dispatched"
            || self.value["phase"] != "reservation_pending"
            || (!self.value["originalManagerFileSha256"].is_null()
                && self.value["originalManagerFileSha256"] != digest)
            || now < self.value["checkedAtMillis"].as_i64().ok_or_else(invalid)?
        {
            return Err(invalid());
        }
        let mut value = self.value.clone();
        value["originalManagerFileSha256"] = json!(digest);
        value["checkedAtMillis"] = json!(now);
        self.replace(value)
    }
    /// No transport, bootstrap or target effect may precede this durable CAS.
    /// Dispatch-unknown never changes back, including after an RPC error.
    pub(crate) fn mark_dispatch(&mut self, key: &str, now: i64) -> Result<()> {
        if self.value["version"] == 1 {
            return Ok(());
        } // Legacy forward recovery has no rollback eligibility.
        if !matches!(key, "bootstrapDispatchState" | "reserveDispatchState")
            || self.value["rollbackState"] != "not_selected"
            || self.value["originalManagerFileSha256"].is_null()
            || !matches!(
                self.value["phase"].as_str(),
                Some("reservation_pending" | "normalization_pending")
            )
            || now < self.value["checkedAtMillis"].as_i64().ok_or_else(invalid)?
        {
            return Err(invalid());
        }
        if key == "reserveDispatchState"
            && self.value["bootstrapDispatchState"] != "dispatch-unknown"
        {
            return Err(invalid());
        }
        let mut value = self.value.clone();
        value[key] = json!("dispatch-unknown");
        value["checkedAtMillis"] = json!(now);
        self.replace(value)
    }
    pub(crate) fn rollback_eligible(&self) -> Result<()> {
        self.assert_current()?;
        if self.value["version"] != 2
            || self.value["phase"] != "reservation_pending"
            || self.value["bootstrapDispatchState"] != "never-dispatched"
            || self.value["reserveDispatchState"] != "never-dispatched"
            || self.value["originalManagerFileSha256"].is_null()
            || [
                "finalizationRequest",
                "observationRequest",
                "targetRestartRequest",
                "finalReceiptFileSha256",
            ]
            .iter()
            .any(|k| !self.value[k].is_null())
        {
            return Err(error(
                "autonomous_research_installed_schema_early_rollback_unknown_or_irreversible",
            ));
        }
        Ok(())
    }
    pub(crate) fn select_rollback(&mut self, now: i64) -> Result<()> {
        self.rollback_eligible()?;
        if self.value["rollbackState"] == "not_selected" {
            self.advance_rollback("control_restore_pending", now)?;
        }
        Ok(())
    }
    pub(crate) fn advance_rollback(&mut self, next: &str, now: i64) -> Result<()> {
        self.rollback_eligible()?;
        let old = ROLLBACK_STATES
            .iter()
            .position(|k| self.value["rollbackState"] == *k)
            .ok_or_else(invalid)?;
        let new = ROLLBACK_STATES
            .iter()
            .position(|k| *k == next)
            .ok_or_else(invalid)?;
        if new < old
            || new > old + 1
            || now < self.value["checkedAtMillis"].as_i64().ok_or_else(invalid)?
        {
            return Err(invalid());
        }
        let mut value = self.value.clone();
        value["rollbackState"] = json!(next);
        value["checkedAtMillis"] = json!(now);
        self.replace(value)
    }
    /// Select full immutable request and hash in one fsync-backed CAS before
    /// the kernel publishes progress. A crash can recover the same request.
    pub(crate) fn select_request(
        &mut self,
        key: &str,
        request: &Value,
        digest: &str,
        now: i64,
    ) -> Result<()> {
        self.assert_current()?;
        let (request_key, _, domain) = REQUESTS
            .iter()
            .find(|(_, hash_key, _)| *hash_key == key)
            .ok_or_else(invalid)?;
        if !sha(&json!(digest))
            || hash(domain, request)? != digest
            || now < self.value["checkedAtMillis"].as_i64().ok_or_else(invalid)?
            || (!self.value[key].is_null()
                && (self.value[key] != digest || self.value[request_key] != *request))
        {
            return Err(invalid());
        }
        if self.value["version"] == 2 && self.value["rollbackState"] != "not_selected" {
            return Err(invalid());
        }
        let expected = match key {
            "finalizationRequestHash" => "installation_pending",
            "targetRestartRequestHash" | "observationRequestHash" => "finalization_pending",
            _ => return Err(invalid()),
        };
        if self.value["phase"] != expected {
            return Err(invalid());
        }
        let mut value = self.value.clone();
        value[key] = json!(digest);
        value[request_key] = request.clone();
        value["checkedAtMillis"] = json!(now);
        self.replace(value)
    }
    fn replace(&mut self, value: Value) -> Result<()> {
        self.assert_current()?;
        if value["version"] == 2 {
            validate_v2_boundary(&value)?;
        }
        publish_receipt(&self.directory, NAME, &value, Some(&self.hash))?;
        let (current, observed, digest) = read(&self.directory)?;
        if current != value {
            return Err(invalid());
        }
        self.value = current;
        self.observed = observed;
        self.hash = digest;
        self.assert_current()
    }
    pub(crate) fn advance(
        &mut self,
        phase: &str,
        request_hash: Option<(&str, &str)>,
        now: i64,
    ) -> Result<()> {
        self.assert_current()?;
        let old = PHASES
            .iter()
            .position(|v| self.value["phase"] == *v)
            .ok_or_else(invalid)?;
        let new = PHASES
            .iter()
            .position(|v| *v == phase)
            .ok_or_else(invalid)?;
        if self.value["version"] == 2 && self.value["rollbackState"] != "not_selected" {
            return Err(invalid());
        }
        let skip_v1_restart = self.value["plan"]["version"] == 1 && old == 3 && new == 5;
        if new < old
            || (new > old + 1 && !skip_v1_restart)
            || now < self.value["checkedAtMillis"].as_i64().ok_or_else(invalid)?
        {
            return Err(invalid());
        }
        let mut value = self.value.clone();
        value["phase"] = json!(phase);
        value["checkedAtMillis"] = json!(now);
        if let Some((key, digest)) = request_hash {
            if ![
                "finalizationRequestHash",
                "observationRequestHash",
                "targetRestartRequestHash",
                "finalReceiptFileSha256",
            ]
            .contains(&key)
                || !sha(&json!(digest))
                || (!value[key].is_null() && value[key] != digest)
            {
                return Err(invalid());
            }
            value[key] = json!(digest);
        }
        self.replace(value)
    }
}
fn read(directory: &Directory) -> Result<(Value, Snapshot, String)> {
    directory.assert_current()?;
    let mut file = std::fs::File::from(
        openat(
            directory.held.as_fd(),
            NAME,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() == 0
        || metadata.len() > MAXIMUM_BYTES
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAXIMUM_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 != metadata.len() {
        return Err(invalid());
    }
    let digest = hash_bytes(&bytes);
    let observed = Snapshot::load(
        &directory.path.join(NAME),
        &digest,
        MAXIMUM_BYTES,
        &invalid().code,
    )?;
    if observed.file.metadata().map_err(|_| invalid())?.ino() != metadata.ino() {
        return Err(invalid());
    }
    let value = parse(&bytes, &invalid().code)?;
    directory.assert_current()?;
    Ok((value, observed, digest))
}

const REQUESTS: [(&str, &str, &str); 3] = [
    (
        "finalizationRequest",
        "finalizationRequestHash",
        "AutonomousResearchOnlineSchemaTransitionFinalizeRequest",
    ),
    (
        "observationRequest",
        "observationRequestHash",
        "AutonomousResearchOnlineSchemaTransitionObserveRequest",
    ),
    (
        "targetRestartRequest",
        "targetRestartRequestHash",
        "AutonomousResearchOnlineSchemaTransitionObserveRequest",
    ),
];

fn validate_v2_boundary(value: &Value) -> Result<()> {
    if ["bootstrapDispatchState", "reserveDispatchState"]
        .iter()
        .any(|k| {
            !matches!(
                value[k].as_str(),
                Some("never-dispatched" | "dispatch-unknown")
            )
        })
        || (!value["originalManagerFileSha256"].is_null()
            && !sha(&value["originalManagerFileSha256"]))
        || !ROLLBACK_STATES.iter().any(|k| value["rollbackState"] == *k)
        || (value["originalManagerFileSha256"].is_null()
            && (value["bootstrapDispatchState"] == "dispatch-unknown"
                || value["reserveDispatchState"] == "dispatch-unknown"))
        || (value["reserveDispatchState"] == "dispatch-unknown"
            && value["bootstrapDispatchState"] != "dispatch-unknown")
        || (value["phase"] != "reservation_pending"
            && value["reserveDispatchState"] != "dispatch-unknown")
    {
        return Err(invalid());
    }
    if value["rollbackState"] != "not_selected"
        && (value["phase"] != "reservation_pending"
            || value["bootstrapDispatchState"] != "never-dispatched"
            || value["reserveDispatchState"] != "never-dispatched"
            || value["originalManagerFileSha256"].is_null()
            || [
                "finalizationRequest",
                "observationRequest",
                "targetRestartRequest",
                "finalReceiptFileSha256",
            ]
            .iter()
            .any(|k| !value[k].is_null()))
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::process::Command;
    const SELECTOR: &str = "online_schema_execution::installed_owner::journal::tests::durable_dispatch_and_selected_inverse_are_monotonic_across_crash";
    // This unit test exercises only root intent/CAS and dispatch admission.
    // A synthetic plan here never constructs a kernel or installed guard.
    pub(in crate::online_schema_execution::installed_owner) fn intent(
        root: &std::path::Path,
    ) -> ExecutionJournalV1 {
        let directory = Directory::open_or_create(root, true).unwrap();
        let mut value = Value::Object(
            KEYS_V1
                .iter()
                .chain(KEYS_V2_EXTRA)
                .map(|k| ((*k).to_string(), Value::Null))
                .collect(),
        );
        value["version"] = json!(2);
        value["kind"] = json!("HeptaInstalledSchemaExecutionIntentV2");
        value["phase"] = json!("reservation_pending");
        value["checkedAtMillis"] = json!(1);
        value["bootstrapDispatchState"] = json!("never-dispatched");
        value["reserveDispatchState"] = json!("never-dispatched");
        value["rollbackState"] = json!("not_selected");
        value["originalManagerFileSha256"] = json!(hash_bytes(b"selected-original-manager"));
        validate_v2_boundary(&value).unwrap();
        publish_receipt(&directory, NAME, &value, None).unwrap();
        reopened(directory)
    }
    fn reopened(directory: Directory) -> ExecutionJournalV1 {
        let (value, observed, hash) = read(&directory).unwrap();
        validate_v2_boundary(&value).unwrap();
        ExecutionJournalV1 {
            directory,
            value,
            observed,
            hash,
        }
    }
    #[test]
    #[ignore = "requires root solely for private root-owned intent CAS; no host effects"]
    fn durable_dispatch_and_selected_inverse_are_monotonic_across_crash() {
        if nix::unistd::getuid().as_raw() != 0 {
            let child = Command::new("sudo")
                .args(["-n"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", SELECTOR, "--ignored", "--test-threads=1"])
                .output()
                .unwrap();
            assert!(
                child.status.success(),
                "{} {}",
                String::from_utf8_lossy(&child.stdout),
                String::from_utf8_lossy(&child.stderr)
            );
            assert!(
                String::from_utf8_lossy(&child.stdout)
                    .contains("test result: ok. 1 passed; 0 failed; 0 ignored;")
            );
            return;
        }
        let root =
            std::env::temp_dir().join(format!("hepta-early-dispatch-cas-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let mut unknown = intent(&root.join("unknown"));
        unknown.rollback_eligible().unwrap();
        assert!(unknown.mark_dispatch("reserveDispatchState", 2).is_err());
        unknown.mark_dispatch("bootstrapDispatchState", 2).unwrap();
        assert!(unknown.rollback_eligible().is_err());
        drop(unknown);
        let mut recovered =
            reopened(Directory::open_or_create(&root.join("unknown"), false).unwrap());
        assert_eq!(
            recovered.value()["bootstrapDispatchState"],
            "dispatch-unknown"
        );
        assert!(recovered.select_rollback(3).is_err());
        recovered.mark_dispatch("reserveDispatchState", 3).unwrap();
        recovered.advance("normalization_pending", None, 4).unwrap();
        assert!(recovered.rollback_eligible().is_err());
        let mut inverse = intent(&root.join("inverse"));
        inverse.select_rollback(2).unwrap();
        drop(inverse);
        let mut inverse =
            reopened(Directory::open_or_create(&root.join("inverse"), false).unwrap());
        assert_eq!(inverse.value()["rollbackState"], "control_restore_pending");
        assert!(inverse.mark_dispatch("bootstrapDispatchState", 3).is_err());
        assert!(inverse.advance("normalization_pending", None, 3).is_err());
        inverse
            .advance_rollback("writer_resume_pending", 3)
            .unwrap();
        inverse.advance_rollback("completed", 4).unwrap();
        assert!(inverse.advance_rollback("not_selected", 5).is_err());
        assert!(
            inverse
                .advance_rollback("control_restore_pending", 5)
                .is_err()
        );
        assert!(inverse.mark_dispatch("reserveDispatchState", 5).is_err());
        let before = fs::read(inverse.directory.path.join(NAME)).unwrap();
        assert_eq!(
            inverse.value()["bootstrapDispatchState"],
            "never-dispatched"
        );
        assert_eq!(inverse.value()["reserveDispatchState"], "never-dispatched");
        fs::write(inverse.directory.path.join(NAME), b"unknown replacement").unwrap();
        assert!(inverse.assert_current().is_err());
        assert_ne!(fs::read(inverse.directory.path.join(NAME)).unwrap(), before);
        let mut invalid = json!({"phase":"reservation_pending","bootstrapDispatchState":"never-dispatched","reserveDispatchState":"dispatch-unknown","originalManagerFileSha256":null,"rollbackState":"control_restore_pending","finalizationRequest":null,"observationRequest":null,"targetRestartRequest":null,"finalReceiptFileSha256":null});
        assert!(validate_v2_boundary(&invalid).is_err());
        invalid["bootstrapDispatchState"] = json!("dispatch-unknown");
        assert!(validate_v2_boundary(&invalid).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
