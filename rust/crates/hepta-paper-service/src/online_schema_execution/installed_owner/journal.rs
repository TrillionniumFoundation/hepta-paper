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
        if !keys(
            &value,
            &[
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
            ],
        ) || value["version"] != 1
            || value["kind"] != "HeptaInstalledSchemaExecutionIntentV1"
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
        let value = json!({"version":1,"kind":"HeptaInstalledSchemaExecutionIntentV1","runtimeRoot":operation.runtime_root,"transitionId":operation.transition_id,"planHash":operation.plan_hash,"profileSha256":operation.profile_sha256,"sourceAuthorityConfigurationHash":source_hash,"plan":plan,"reserveRequest":request,"reserveRequestHash":hash("AutonomousResearchOnlineSchemaTransitionReserveRequest",request)?,"phase":"reservation_pending","checkedAtMillis":now,"finalizationRequestHash":null,"observationRequestHash":null,"targetRestartRequestHash":null,"finalReceiptFileSha256":null,"finalizationRequest":null,"observationRequest":null,"targetRestartRequest":null,"previousFinalReceiptFileSha256":previous_final_pin});
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
