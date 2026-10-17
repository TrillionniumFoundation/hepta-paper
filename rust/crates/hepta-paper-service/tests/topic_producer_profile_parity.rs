//! Actual incumbent profile builders, dataset manifests and loader; no generation,
//! canary execution, topic authority or independent acceptance is established.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::topic_producer_profile::{
    TopicProducerProfileReadOptionsV1, read_autonomous_research_topic_producer_profile_v1 as read,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
const EVIDENCE: &str = "owned_original_topic_profile_and_dataset_fixture_no_generation_canary_or_independent_acceptance";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    repository: PathBuf,
    profile: PathBuf,
    datasets: PathBuf,
    environment: BTreeMap<String, String>,
    setup: Value,
}
impl Fixture {
    fn new(layout: &str) -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hepta-topic-profile-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let mut fixture = Self {
            profile: root.join("profile.json"),
            datasets: root.join("datasets"),
            root,
            repository: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap(),
            environment: BTreeMap::new(),
            setup: Value::Null,
        };
        fs::write(
            fixture.root.join(".owned-topic-profile-fixture"),
            "owned topic profile fixture\n",
        )
        .unwrap();
        fixture.setup = fixture.oracle(json!({"action":"setup","layout":layout}));
        fixture.environment = serde_json::from_value(fixture.setup["environment"].clone()).unwrap();
        fixture
    }
    fn oracle(&self, mut input: Value) -> Value {
        input["root"] = json!(self.root);
        let encoded = input.to_string();
        assert!(encoded.len() < 64 * 1024);
        let mut command = Command::new("node");
        command
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../oracle/topic-producer-profile-v1.mjs"),
            )
            .arg(encoded)
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").expect("qualified Node"))
            .env("LANG", "en_US.UTF-8");
        let output = machine_intake_support::run(&mut command);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&output["profile"]).unwrap();
        assert_eq!(output["value"]["evidenceScope"], EVIDENCE);
        output["value"].clone()
    }
    fn options(&self) -> TopicProducerProfileReadOptionsV1<'_> {
        TopicProducerProfileReadOptionsV1 {
            profile_path: Some(&self.profile),
            dataset_root: Some(&self.datasets),
            repository_root: &self.repository,
            working_directory: &self.root,
            environment: &self.environment,
            expected_profile_hash: None,
            expected_provider_configuration_hash: None,
        }
    }
    fn compare(&self, options: &TopicProducerProfileReadOptionsV1<'_>, label: &str) -> Value {
        let expected=self.oracle(json!({"action":"inspect","profilePath":options.profile_path,"datasetRoot":options.dataset_root,"environment":options.environment,"expectedProfileHash":options.expected_profile_hash,"expectedProviderConfigurationHash":options.expected_provider_configuration_hash}));
        let before = snapshot(&self.root);
        let actual = match read(options) {
            Ok(owner) => {
                owner.assert_current().expect("source remains current");
                json!({"ok":true,"value":owner.identity()})
            }
            Err(error) => json!({"ok":false,"error":error.code()}),
        };
        let mut expected = expected;
        expected.as_object_mut().unwrap().remove("evidenceScope");
        assert_eq!(
            actual, expected,
            "complete original loader projection/error: {label}"
        );
        assert_eq!(snapshot(&self.root), before, "source mutation: {label}");
        assert!(!self.root.join("executed-marker").exists());
        actual
    }
    fn restore_profile(&self) {
        fs::write(
            &self.profile,
            serde_json::to_vec(&self.setup["profile"]).unwrap(),
        )
        .unwrap();
    }
    fn write_profile(&self, profile: &Value) {
        fs::write(&self.profile, serde_json::to_vec(profile).unwrap()).unwrap();
    }
    fn rehash(&self, registered: bool) -> Value {
        self.oracle(json!({"action":"rehash-profile","rehashRegistered":registered}))
    }
    fn source(&self) -> PathBuf {
        PathBuf::from(
            self.setup["profile"]["registeredResearchProfiles"][0]["datasetMounts"][0]["source"]
                .as_str()
                .unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn snapshot(root: &Path) -> Vec<Value> {
    fn visit(path: &Path, rows: &mut Vec<Value>) {
        let m = fs::symlink_metadata(path).unwrap();
        let bytes = if m.is_file() {
            json!(hex::encode(Sha256::digest(fs::read(path).unwrap())))
        } else if m.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else {
            Value::Null
        };
        rows.push(json!({"path":path,"dev":m.dev(),"ino":m.ino(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),"mode":m.mode(),"size":m.size(),"mtime":m.mtime(),"mtimeNs":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNs":m.ctime_nsec(),"bytes":bytes}));
        if m.is_dir() {
            let mut paths = fs::read_dir(path)
                .unwrap()
                .map(|p| p.unwrap().path())
                .collect::<Vec<_>>();
            paths.sort();
            for p in paths {
                visit(&p, rows);
            }
        }
    }
    let mut rows = Vec::new();
    visit(root, &mut rows);
    rows
}
#[test]
fn actual_profiles_and_file_or_unicode_directory_manifests_match_for_all_builtin_families() {
    for layout in ["file", "directory"] {
        let fixture = Fixture::new(layout);
        let actual = fixture.compare(&fixture.options(), layout);
        assert_eq!(actual["ok"], true);
        assert_eq!(
            actual["value"]["producerProfile"]["registeredResearchProfiles"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(
            actual["value"]["datasetSnapshot"]["mounts"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(actual["value"]["implementationIdentity"]["ready"], true);
        assert_eq!(actual["value"], fixture.setup["expected"]["value"]);
    }
}
#[test]
fn actual_selection_precedence_expected_bindings_and_absolute_dataset_requirement_match() {
    let fixture = Fixture::new("file");
    let mut options = fixture.options();
    options.profile_path = None;
    options.dataset_root = None;
    assert_eq!(
        fixture.compare(&options, "environment defaults")["ok"],
        true
    );
    options.profile_path = Some(Path::new("profile.json"));
    options.dataset_root = Some(&fixture.datasets);
    assert_eq!(fixture.compare(&options, "relative profile")["ok"], true);
    options.dataset_root = Some(Path::new("datasets"));
    assert_eq!(
        fixture.compare(&options, "relative dataset")["error"],
        "autonomous_research_topic_producer_dataset_root_required"
    );
    options.dataset_root = Some(&fixture.datasets);
    let profile_hash = fixture.setup["profile"]["producerProfileHash"]
        .as_str()
        .unwrap();
    let provider_hash = fixture.setup["profile"]["providerConfigurationHash"]
        .as_str()
        .unwrap();
    options.expected_profile_hash = Some(profile_hash);
    options.expected_provider_configuration_hash = Some(provider_hash);
    assert_eq!(
        fixture.compare(&options, "matching expected identities")["ok"],
        true
    );
    let wrong = format!("sha256:{}", "e".repeat(64));
    options.expected_profile_hash = Some(&wrong);
    assert_eq!(
        fixture.compare(&options, "profile identity mismatch")["ok"],
        false
    );
    options.expected_profile_hash = Some(profile_hash);
    options.expected_provider_configuration_hash = Some(&wrong);
    assert_eq!(
        fixture.compare(&options, "provider identity mismatch")["ok"],
        false
    );
    options.expected_profile_hash = Some("");
    options.expected_provider_configuration_hash = Some("");
    assert_eq!(
        fixture.compare(&options, "empty expected values")["ok"],
        true
    );
    let empty = BTreeMap::new();
    options.environment = &empty;
    options.profile_path = None;
    assert_eq!(
        fixture.compare(&options, "missing profile")["error"],
        "autonomous_research_topic_producer_profile_required"
    );
    options.profile_path = Some(&fixture.profile);
    options.dataset_root = None;
    assert_eq!(
        fixture.compare(&options, "missing dataset")["error"],
        "autonomous_research_topic_producer_dataset_root_required"
    );
}
#[test]
fn rehashed_producer_limits_policy_and_exact_keys_match_original_contract() {
    let fixture = Fixture::new("file");
    for (key, value, valid) in [
        ("capabilityValidityMs", json!(60_000), true),
        ("capabilityValidityMs", json!(59_999), false),
        ("capabilityValidityMs", json!(900_001), false),
        ("minimumGenerationIntervalMs", json!(7_200_000), true),
        ("minimumGenerationIntervalMs", json!(3_600_001), false),
        ("maximumTopicsPerUtcDay", json!(0), false),
        ("maximumTopicsPerUtcDay", json!(25), false),
        ("maximumProviderCanaryAttemptsPerUtcDay", json!(1), false),
        ("maximumProviderCanaryAttemptsPerUtcDay", json!(49), false),
        ("maximumProviderCanaryCostUsdPerUtcDay", json!(0.0), false),
        ("maximumProviderCanaryCostUsdPerUtcDay", json!(100.0), true),
        (
            "maximumProviderCanaryCostUsdPerUtcDay",
            json!(100.01),
            false,
        ),
        ("producerId", json!("bad/id"), false),
        ("implementationId", json!("unknown-implementation"), false),
        ("policyId", json!("untrusted-policy"), false),
        (
            "policyProfileHash",
            json!(format!("sha256:{}", "d".repeat(64))),
            false,
        ),
        ("extra", json!(true), false),
    ] {
        let mut profile = fixture.setup["profile"].clone();
        profile[key] = value;
        fixture.write_profile(&profile);
        let rehashed = fixture.rehash(false);
        assert_eq!(rehashed["verified"], valid, "original rehashed {key}");
        assert_eq!(
            fixture.compare(&fixture.options(), key)["ok"],
            valid,
            "{key}"
        );
    }
}
#[test]
fn rehashed_registered_profile_normalization_duplicates_and_bindings_match() {
    let fixture = Fixture::new("file");
    for (key, value) in [
        ("objective", json!("  A noncanonical objective.  ")),
        ("profileId", json!("bad/id")),
        ("protocolFamily", json!("unknown_family")),
        ("revisionRounds", json!(0)),
        ("refereeCount", json!(1)),
        ("replicationPolicy", json!("unbounded")),
        (
            "canonicalResearchTopicHash",
            json!(format!("sha256:{}", "a".repeat(64))),
        ),
        ("extra", json!("not-an-original-key")),
    ] {
        let mut profile = fixture.setup["profile"].clone();
        profile["registeredResearchProfiles"][0][key] = value;
        fixture.write_profile(&profile);
        assert_eq!(fixture.rehash(true)["verified"], false);
        assert_eq!(fixture.compare(&fixture.options(), key)["ok"], false);
    }
    for count in [0, 2, 17] {
        let mut profile = fixture.setup["profile"].clone();
        let first = profile["registeredResearchProfiles"][0].clone();
        profile["registeredResearchProfiles"] = json!(vec![first; count]);
        fixture.write_profile(&profile);
        assert_eq!(
            fixture.rehash(true)["verified"],
            false,
            "empty/duplicate/oversize actual profiles"
        );
        assert_eq!(
            fixture.compare(&fixture.options(), "profile array")["ok"],
            false
        );
    }
}
#[test]
fn actual_numeric_spelling_json_permissions_and_profile_size_boundaries_match() {
    let fixture = Fixture::new("file");
    let original = fs::read_to_string(&fixture.profile).unwrap();
    let numeric = original
        .replace("\"version\":1", "\"version\":1e0")
        .replace("\"maxGpuJobs\":0", "\"maxGpuJobs\":-0");
    assert_ne!(numeric, original);
    fs::write(&fixture.profile, numeric).unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "Node numeric transport")["ok"],
        true
    );
    for size in [1024 * 1024, 1024 * 1024 + 1] {
        let mut bytes = original.as_bytes().to_vec();
        bytes.resize(size, b' ');
        fs::write(&fixture.profile, bytes).unwrap();
        assert_eq!(
            fixture.compare(&fixture.options(), "profile size boundary")["ok"],
            size == 1024 * 1024
        );
    }
    fs::write(&fixture.profile, b"{invalid json").unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "invalid JSON")["error"],
        "autonomous_research_topic_producer_profile_json_invalid"
    );
    fixture.restore_profile();
    fs::set_permissions(&fixture.profile, fs::Permissions::from_mode(0o664)).unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "writable profile")["error"],
        "autonomous_research_topic_producer_profile_file_invalid"
    );
    fs::set_permissions(&fixture.profile, fs::Permissions::from_mode(0o600)).unwrap();
    let target = fixture.root.join("profile-original.json");
    fs::rename(&fixture.profile, &target).unwrap();
    symlink(&target, &fixture.profile).unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "profile symlink")["error"],
        "autonomous_research_topic_producer_profile_file_invalid"
    );
    fs::remove_file(&fixture.profile).unwrap();
    nix::unistd::mkfifo(
        &fixture.profile,
        nix::sys::stat::Mode::from_bits_truncate(0o600),
    )
    .unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "profile FIFO")["error"],
        "autonomous_research_topic_producer_profile_file_invalid"
    );
}
#[test]
fn actual_dataset_bytes_links_and_roots_are_observed_instead_of_trusting_claimed_hash() {
    let fixture = Fixture::new("file");
    let source = fixture.source();
    let original = fs::read(&source).unwrap();
    fs::write(&source, b"changed actual owned source").unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "dataset content drift")["error"],
        "autonomous_research_topic_producer_dataset_manifest_invalid_or_mismatched"
    );
    fs::write(&source, &original).unwrap();
    let alias = fixture.root.join("extra-hardlink");
    fs::hard_link(&source, &alias).unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "dataset hardlink")["ok"],
        false
    );
    fs::remove_file(alias).unwrap();
    let target = fixture.datasets.join("relocated.txt");
    fs::rename(&source, &target).unwrap();
    symlink(&target, &source).unwrap();
    assert_eq!(
        fixture.compare(&fixture.options(), "mounted symlink")["error"],
        "autonomous_research_topic_producer_dataset_source_invalid"
    );
    fs::remove_file(&source).unwrap();
    fs::rename(&target, &source).unwrap();
    let alias = fixture.root.join("dataset-alias");
    symlink(&fixture.datasets, &alias).unwrap();
    let mut options = fixture.options();
    options.dataset_root = Some(&alias);
    assert_eq!(
        fixture.compare(&options, "dataset root symlink")["error"],
        "autonomous_research_topic_producer_dataset_root_invalid"
    );
}
#[test]
fn actual_implementation_bytes_are_required_after_a_valid_rehashed_profile() {
    let fixture = Fixture::new("file");
    let mut profile = fixture.setup["profile"].clone();
    profile["implementationSha256"] = json!(format!("sha256:{}", "c".repeat(64)));
    fixture.write_profile(&profile);
    assert_eq!(
        fixture.rehash(false)["verified"],
        true,
        "original profile shape and own hash alone are valid"
    );
    assert_eq!(
        fixture.compare(&fixture.options(), "actual implementation mismatch")["error"],
        "autonomous_research_topic_producer_implementation_identity_mismatch"
    );
    fixture.restore_profile();
    let copied = fixture.root.join("owned-repository");
    let relative =
        "paper-adapters/automation/autonomous-research-topic-producer-implementation.mjs";
    fs::create_dir_all(copied.join("paper-adapters/automation")).unwrap();
    fs::copy(fixture.repository.join(relative), copied.join(relative)).unwrap();
    let mut options = fixture.options();
    options.repository_root = &copied;
    // Explicit native repository selection is an embedding input; this is a
    // retained-file test, not original CLI relocation qualification.
    let owner = read(&options).unwrap();
    assert_eq!(
        owner.identity()["implementationIdentity"]["implementationSha256"],
        fixture.setup["profile"]["implementationSha256"]
    );
    fs::write(copied.join(relative), b"changed owned implementation bytes").unwrap();
    assert!(owner.assert_current().is_err());
}

#[test]
fn original_backslash_alias_read_is_explicitly_refused_by_native_path_profile() {
    let fixture = Fixture::new("directory");
    let source = fixture.source();
    fs::create_dir(source.join("alias")).unwrap();
    fs::write(source.join("alias/value"), b"owned alias content").unwrap();
    fs::write(
        source.join("alias\\value"),
        b"different literal filename content",
    )
    .unwrap();
    let original = fixture.oracle(json!({"action":"refresh-datasets"}));
    assert_eq!(
        original["ok"], true,
        "actual original loader rewrites the relative name before reading"
    );
    let before = snapshot(&fixture.root);
    let error = match read(&fixture.options()) {
        Ok(_) => panic!("native must not silently bind the alias file"),
        Err(error) => error,
    };
    assert!(error.code().ends_with("dataset_relative_name_unsupported"));
    assert_eq!(snapshot(&fixture.root), before);
}

#[test]
fn original_array_hash_transport_has_an_explicit_native_profile_refusal() {
    let fixture = Fixture::new("file");
    let mut profile = fixture.setup["profile"].clone();
    profile["registeredResearchProfiles"][0]["datasetMounts"][0]["analysisProtocolHash"] =
        json!([format!("sha256:{}", "b".repeat(64))]);
    fixture.write_profile(&profile);
    let original = fixture.oracle(json!({"action":"refresh-datasets"}));
    assert_eq!(
        original["ok"], true,
        "actual builder and loader preserve this String(array) hash transport"
    );
    let before = snapshot(&fixture.root);
    let error = match read(&fixture.options()) {
        Ok(_) => panic!("native mount transport profile must be explicit"),
        Err(error) => error,
    };
    assert!(
        error
            .code()
            .ends_with("dataset_mount_transport_unsupported")
    );
    assert_eq!(snapshot(&fixture.root), before);
}

#[test]
fn retained_real_owner_rejects_content_profile_and_empty_directory_namespace_drift() {
    for mutation in ["content", "profile", "new-entry", "empty-directory"] {
        let fixture = Fixture::new("directory");
        let owner = read(&fixture.options()).unwrap();
        owner.assert_current().unwrap();
        match mutation {
            "content" => {
                fs::write(fixture.source().join("a.txt"), b"changed retained source").unwrap();
            }
            "profile" => {
                let mut profile = fixture.setup["profile"].clone();
                profile["producerId"] = json!("changed-owner");
                fixture.write_profile(&profile);
            }
            "new-entry" => {
                fs::write(
                    fixture.source().join("added.txt"),
                    b"new owned namespace member",
                )
                .unwrap();
            }
            "empty-directory" => {
                fs::remove_dir(fixture.source().join("empty")).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            owner.assert_current().is_err(),
            "retained owner missed {mutation}"
        );
    }
}
