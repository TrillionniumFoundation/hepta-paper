//! One retained observation set for the real fresh-schema execution path.
use super::{AutonomousStateProvisioningOptions, Result, error, files::Snapshot, input_hash};
use crate::{
    machine_intake::{configuration::verify_configuration_v2, contract},
    pristine_runtime_state::machine::{PinnedMachineGenesisDocumentsV1, verify_external},
    topic_producer_profile::{
        ObservedTopicProducerProfileV1, TopicProducerProfileReadOptionsV1,
        read_autonomous_research_topic_producer_profile_v1,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};

const INPUT: &str = "autonomous_state_provisioning_execution_input_invalid";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenesisInputs {
    version: u32,
    kind: String,
    owner_trust_store: Pin,
    genesis_envelope: Pin,
    rotation_trust_store: Pin,
    bootstrap_receipt: Pin,
}
fn parse(bytes: &[u8]) -> Result<Value> {
    crate::sqlite_mutation_coordinator::authority::files::parse(bytes, INPUT)
        .map_err(|_| error(INPUT))
}
fn read(path: &std::path::Path) -> Result<Snapshot> {
    Snapshot::read(path).map_err(|_| error(INPUT))
}
pub(super) fn now() -> Result<String> {
    crate::nested_runtime_cli::current_nested_runtime_clock_v1()
        .map_err(|_| error("autonomous_state_provisioning_clock_unavailable"))
}
/// No constructor accepts caller-provided ready booleans or prepared database bytes.
pub(super) struct Inputs {
    snapshots: Vec<Snapshot>,
    topic_owner: ObservedTopicProducerProfileV1,
    genesis: PinnedMachineGenesisDocumentsV1,
    pub machine: Value,
    pub topic: Value,
    pub authority: (Value, Value, Value),
    pub manifest: Value,
    pub policy: Value,
    pub binding: Value,
}
impl Inputs {
    pub fn load(options: &AutonomousStateProvisioningOptions) -> Result<Self> {
        if options.machine_intake_genesis_authority != "external" {
            return Err(error(
                "autonomous_state_provisioning_native_external_genesis_required",
            ));
        }
        let path = options
            .genesis_inputs
            .as_ref()
            .ok_or_else(|| error(INPUT))?;
        let pin = options
            .genesis_inputs_sha256
            .as_ref()
            .ok_or_else(|| error(INPUT))?;
        let manifest_file = read(path)?;
        if manifest_file.bytes.len() > 65_536
            || manifest_file.observation()["observedSha256"] != *pin
        {
            return Err(error(
                "autonomous_state_provisioning_genesis_inputs_pin_mismatch",
            ));
        }
        let source = parse(&manifest_file.bytes)?;
        let authority: GenesisInputs =
            serde_json::from_value(source.clone()).map_err(|_| error(INPUT))?;
        if authority.version != 1 || authority.kind != "NativeStateProvisioningGenesisInputsV1" {
            return Err(error(INPUT));
        }
        let pins = [
            &authority.owner_trust_store,
            &authority.genesis_envelope,
            &authority.rotation_trust_store,
            &authority.bootstrap_receipt,
        ];
        if pins
            .iter()
            .any(|p| !p.path.is_absolute() || !super::valid_hash(&p.sha256))
        {
            return Err(error(INPUT));
        }
        fn pair(pin: &Pin) -> (&std::path::Path, &str) {
            (pin.path.as_path(), pin.sha256.as_str())
        }
        let genesis = PinnedMachineGenesisDocumentsV1::load(
            pair(&authority.owner_trust_store),
            pair(&authority.genesis_envelope),
            pair(&authority.rotation_trust_store),
            pair(&authority.bootstrap_receipt),
        )
        .map_err(|_| error("autonomous_state_provisioning_genesis_documents_invalid"))?;
        let machine_file = read(&options.machine_intake_config)?;
        let machine = parse(&machine_file.bytes)?;
        if !verify_configuration_v2(&machine) {
            return Err(error(
                "autonomous_state_provisioning_machine_configuration_invalid",
            ));
        }
        let topic_file = read(&options.topic_producer_profile)?;
        let topic = parse(&topic_file.bytes)?;
        let environment = BTreeMap::new();
        let working_directory = std::env::current_dir().map_err(|_| error(INPUT))?;
        let topic_owner = read_autonomous_research_topic_producer_profile_v1(
            &TopicProducerProfileReadOptionsV1 {
                profile_path: Some(&options.topic_producer_profile),
                dataset_root: Some(&options.dataset_root),
                repository_root: &options.workspace_root,
                working_directory: &working_directory,
                environment: &environment,
                expected_profile_hash: machine["machineProducerProfileHash"].as_str(),
                expected_provider_configuration_hash: topic["providerConfigurationHash"].as_str(),
            },
        )
        .map_err(|_| error("autonomous_state_provisioning_topic_or_dataset_invalid"))?;
        if topic_owner.identity()["producerProfile"] != topic {
            return Err(error("autonomous_state_provisioning_topic_changed"));
        }
        let mut snapshots = vec![manifest_file, machine_file, topic_file];
        let mut aggregate = snapshots.iter().map(|s| s.bytes.len()).sum::<usize>();
        for descriptor in machine["staticIntakeFiles"]
            .as_array()
            .ok_or_else(|| error(INPUT))?
        {
            let source = read(std::path::Path::new(
                descriptor["path"].as_str().ok_or_else(|| error(INPUT))?,
            ))?;
            aggregate = aggregate
                .checked_add(source.bytes.len())
                .ok_or_else(|| error(INPUT))?;
            if aggregate > 16 * 1024 * 1024 {
                return Err(error(INPUT));
            }
            let intake = parse(&source.bytes)?;
            if !contract::verify_intake(&intake)
                || intake["intakeHash"] != descriptor["intakeHash"]
                || intake["launchMode"] != "production-run"
                || !intake["recurringGoldenProvenance"].is_null()
                || intake["providerConfigurationHash"] != topic["providerConfigurationHash"]
            {
                return Err(error("autonomous_state_provisioning_static_intake_invalid"));
            }
            snapshots.push(source);
        }
        if !(1..=10_000).contains(&options.maximum_attempts_per_epoch)
            || !options.maximum_cost_usd_per_epoch.is_finite()
            || options.maximum_cost_usd_per_epoch <= 0.0
            || options.maximum_cost_usd_per_epoch > 100_000_000.0
        {
            return Err(error(
                "autonomous_state_provisioning_refresh_policy_invalid",
            ));
        }
        let mut policy = json!({"version":1,"kind":"RuntimeReproducibilityRefreshPolicy",
            "budgetEpochMs":86_400_000,"maximumAttemptsPerEpoch":options.maximum_attempts_per_epoch,
            "maximumCostUsdPerEpoch":options.maximum_cost_usd_per_epoch,"leaseMs":600_000,
            "baseBackoffMs":30_000,"maximumBackoffMs":300_000,"renewalLeadMs":3_600_000,
            "actionSafetyMarginMs":900_000});
        policy["runtimeReproducibilityRefreshPolicyHash"] =
            json!(input_hash("RuntimeReproducibilityRefreshPolicy", &policy)?);
        let manifest = parse(include_bytes!(
            "../../../../../paper-core/config/autonomous-research-state-databases.v1.json"
        ))?;
        let when = now()?;
        let verified = verify_external(
            &genesis,
            &machine["configurationHash"],
            &topic["producerProfileHash"],
            &json!(when),
        )
        .map_err(|_| error("autonomous_state_provisioning_genesis_authority_rejected"))?;
        let binding = json!({"genesisInputs":source,
            "files":snapshots.iter().map(Snapshot::observation).collect::<Vec<_>>(),
            "topicObservation":topic_owner.identity(),"schemaBundleHash":super::schema::bundle_hash()?});
        let inputs = Self {
            snapshots,
            topic_owner,
            genesis,
            machine,
            topic,
            authority: verified,
            manifest,
            policy,
            binding,
        };
        inputs.assert_current()?;
        Ok(inputs)
    }
    pub fn assert_current(&self) -> Result<()> {
        for snapshot in &self.snapshots {
            snapshot.assert_current().map_err(|_| error(INPUT))?;
        }
        self.topic_owner
            .assert_current()
            .map_err(|_| error(INPUT))?;
        self.genesis.assert_current().map_err(|_| error(INPUT))?;
        verify_external(
            &self.genesis,
            &self.machine["configurationHash"],
            &self.topic["producerProfileHash"],
            &json!(now()?),
        )
        .map_err(|_| error("autonomous_state_provisioning_genesis_authority_rejected"))?;
        Ok(())
    }
    pub fn identity(&self) -> Result<Value> {
        let cost = self.topic["maximumProviderCanaryCostUsdPerUtcDay"]
            .as_f64()
            .ok_or_else(|| error(INPUT))?
            / self.topic["maximumProviderCanaryAttemptsPerUtcDay"]
                .as_f64()
                .ok_or_else(|| error(INPUT))?;
        if !cost.is_finite() || cost <= 0.0 {
            return Err(error(INPUT));
        }
        let writer = parse(include_bytes!(
            "../state_recoverability/cli/writer-manifest.v1.json"
        ))?;
        Ok(
            json!({"machineIntakeConfigurationHash":self.machine["configurationHash"],
            "machineIntakeGenesisAuthorityMode":"external","providerCanaryPairMaximumCostUsd":cost,
            "providerConfigurationHash":self.topic["providerConfigurationHash"],
            "runtimeReproducibilityRefreshPolicyHash":self.policy["runtimeReproducibilityRefreshPolicyHash"],
            "topicProducerProfileHash":self.topic["producerProfileHash"],
            "writerManifestHash":input_hash("AutonomousResearchOnlineWriterOperationManifest", &writer)?}),
        )
    }
}
