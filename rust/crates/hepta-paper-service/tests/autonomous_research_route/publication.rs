//! The ordinary CLI supplies the entire workflow. Separate numeric UIDs read the
//! actual protected product inputs and exchange bounded protocol fixture results.
//! These are local OS principals, not live independently authenticated accounts.
use super::*;
use hepta_codex_broker::{
    CommitBoundPreparedResultAcknowledgementV2, ProductCodexOperationPublisherV1,
};
use std::{
    os::unix::fs::MetadataExt,
    path::Path,
    process::{Child, Output},
    time::{Duration, Instant},
};

struct PublicationFixture {
    root: PathBuf,
    executable: PathBuf,
    author: ProductCodexOperationPublisherV1,
    reviewer: ProductCodexOperationPublisherV1,
}
fn chown(paths: &[&Path], uid: u32, gid: u32) {
    assert!(
        Command::new("sudo")
            .args(["-n", "chown", "--no-dereference", &format!("{uid}:{gid}")])
            .args(paths)
            .status()
            .unwrap()
            .success(),
        "isolated numeric-UID ownership setup required"
    );
}
fn directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o750)).unwrap();
}
fn protected(path: &Path, bytes: &[u8]) {
    if path.exists() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o440)).unwrap();
}
impl PublicationFixture {
    fn new(c: &mut Campaign) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hbp-operation-publisher-{}-{}",
            std::process::id(),
            c.author.root.file_name().unwrap().to_str().unwrap()
        ));
        directory(&root);
        let executable = root.join("local-protocol-peer");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o550)).unwrap();
        let author = Self::role(&root, "author", 290001, AgentRole::Author);
        let reviewer = Self::role(&root, "reviewer", 290002, AgentRole::Reviewer);
        for (role, publisher, peer) in [
            (&mut c.request.author, &author, &mut c.author),
            (&mut c.request.reviewer, &reviewer, &mut c.reviewer),
        ] {
            let (workspace_hash, mutation_hash) = publisher.bound_workspace_hashes().unwrap();
            let state = root.join(format!("state-{}", publisher.broker_uid));
            role.source.broker_uid = publisher.broker_uid;
            role.source.broker_gid = publisher.broker_gid;
            role.source.socket_path = state.join("broker.sock");
            peer.socket_path = role.source.socket_path.clone();
            role.source.operation_publisher = Some(publisher.clone());
            role.workspace_identity_hash = workspace_hash;
            role.mutation_policy_hash = mutation_hash;
            role.prompt_envelope_hash = publisher.prompt_prefix_hash.clone();
            role.output_schema_hash = publisher.output_schema_hash.clone();
        }
        c.write();
        Self {
            root,
            executable,
            author,
            reviewer,
        }
    }
    fn role(
        root: &Path,
        name: &str,
        broker_uid: u32,
        role: AgentRole,
    ) -> ProductCodexOperationPublisherV1 {
        let uid = nix::unistd::geteuid().as_raw();
        let gid = nix::unistd::getegid().as_raw();
        let operations = root.join(format!("operations-{name}"));
        let workspace = root.join(format!("workspace-{name}"));
        let state = root.join(format!("state-{broker_uid}"));
        for path in [&operations, &workspace, &state] {
            directory(path);
        }
        chown(&[&workspace, &state], broker_uid, gid);
        let prefix = operations.join("prefix.txt");
        let schema = operations.join("schema.json");
        let prefix_bytes = format!(
            "Act as the declared {name} only on the exact bound manuscript task below. Do not invent evidence."
        );
        let schema_bytes = if role == AgentRole::Author {
            br#"{"type":"object","properties":{"manuscript":{"type":"string"}},"required":["manuscript"],"additionalProperties":false}"#.as_slice()
        } else {
            br#"{"type":"object","properties":{"accepted":{"type":"boolean"},"manuscriptHash":{"type":"string"},"review":{"type":"string"}},"required":["accepted","manuscriptHash","review"],"additionalProperties":false}"#.as_slice()
        };
        protected(&prefix, prefix_bytes.as_bytes());
        protected(&schema, schema_bytes);
        let policy = if role == AgentRole::Author {
            json!({"version":1,"readOnly":false,"allowedPathPrefixes":["draft.md"],"allowedExtensions":["md"],"maximumChangedEntries":4,"maximumChangedFileBytes":1024})
        } else {
            json!({"version":1,"readOnly":true,"allowedPathPrefixes":[],"allowedExtensions":[],"maximumChangedEntries":0,"maximumChangedFileBytes":0})
        };
        serde_json::from_value(json!({"version":1,"role":role,"operationDirectory":operations,"authorityUid":uid,"brokerUid":broker_uid,"brokerGid":gid,"workspacePath":workspace,"promptPrefixPath":prefix,"promptPrefixHash":hash(prefix_bytes.as_bytes()),"outputSchemaPath":schema,"outputSchemaHash":hash(schema_bytes),"mutationPolicy":policy})).unwrap()
    }
    fn publisher(&self, index: usize) -> &ProductCodexOperationPublisherV1 {
        if index.is_multiple_of(2) {
            &self.author
        } else {
            &self.reviewer
        }
    }
    fn spawn(
        &self,
        c: &Campaign,
        index: usize,
        mode: &str,
        result: &[u8],
        ack: Option<&CommitBoundPreparedResultAcknowledgementV2>,
    ) -> Child {
        let publisher = self.publisher(index);
        let peer = if index.is_multiple_of(2) {
            &c.author
        } else {
            &c.reviewer
        };
        let input = publisher.operation_directory.join("reader-call.json");
        let output = peer
            .socket_path
            .parent()
            .unwrap()
            .join(format!("observed-{index}-{mode}.json"));
        protected(&input, &serde_json::to_vec(&json!({"source":publisher,"request":peer.request,"output":output,"mode":mode,"socket":peer.socket_path,"requestPublicKey":peer.request_signer_verifying_key.unwrap().as_bytes(),"result":std::str::from_utf8(result).unwrap(),"ack":ack})).unwrap());
        let mut child = Command::new("sudo")
            .args([
                "-n",
                "setpriv",
                "--reuid",
                &publisher.broker_uid.to_string(),
                "--regid",
                &publisher.broker_gid.to_string(),
                "--clear-groups",
            ])
            .arg("env")
            .arg(format!(
                "HEPTA_TEST_PRODUCT_PROMPT_READER={}",
                input.display()
            ))
            .arg(&self.executable)
            .args([
                "--exact",
                "campaign::fixture_broker_prompt_reader_child",
                "--ignored",
                "--nocapture",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !peer.socket_path.exists() {
            if child.try_wait().unwrap().is_some() {
                let output = child.wait_with_output().unwrap();
                panic!(
                    "distinct broker exited before socket setup: {} {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "distinct broker socket setup timed out: {} {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let metadata = fs::metadata(&peer.socket_path).unwrap();
        assert_eq!(metadata.uid(), publisher.broker_uid);
        assert_eq!(metadata.gid(), publisher.broker_gid);
        child
    }
    fn retire_socket(&self, peer: &Fixture, index: usize) {
        let publisher = self.publisher(index);
        assert_eq!(
            peer.socket_path.parent().unwrap().parent(),
            Some(self.root.as_path())
        );
        assert!(
            Command::new("sudo")
                .args([
                    "-n",
                    "setpriv",
                    "--reuid",
                    &publisher.broker_uid.to_string(),
                    "--regid",
                    &publisher.broker_gid.to_string(),
                    "--clear-groups",
                    "rm",
                    "--"
                ])
                .arg(&peer.socket_path)
                .status()
                .unwrap()
                .success()
        );
    }
    fn finish(&self, c: &Campaign, index: usize, mode: &str, child: Child, manifest: &Value) {
        let output: Output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let peer = if index.is_multiple_of(2) {
            &c.author
        } else {
            &c.reviewer
        };
        self.retire_socket(peer, index);
        let seen: Value = serde_json::from_slice(
            &fs::read(
                peer.socket_path
                    .parent()
                    .unwrap()
                    .join(format!("observed-{index}-{mode}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(seen["uid"], self.publisher(index).broker_uid);
        assert_eq!(
            seen["inputManifestHash"],
            peer.request.input_manifest_hash.as_str()
        );
        assert_eq!(seen["operationId"], peer.request.operation_id);
        assert_eq!(
            seen["prompt"].as_str().unwrap(),
            format!(
                "{}\n\nHepta exact bound input manifest (JSON):\n{}\n",
                fs::read_to_string(&self.publisher(index).prompt_prefix_path).unwrap(),
                serde_json::to_string(manifest).unwrap()
            )
        );
    }
    fn stage(
        &self,
        c: &mut Campaign,
        index: usize,
        output: &[u8],
        cost: u64,
        accepted: bool,
        lose: bool,
    ) -> Value {
        assert_eq!(c.advance(Some(index + 1))["ready"], false);
        let manifest = c.capture(index);
        let peer = if index.is_multiple_of(2) {
            &c.author
        } else {
            &c.reviewer
        };
        let request_bytes = fs::read(&peer.request_path).unwrap();
        let descriptor = self
            .publisher(index)
            .operation_directory
            .join(format!("{}.json", peer.request.operation_id));
        let before = fs::metadata(&descriptor).unwrap();
        assert_eq!(before.uid(), self.publisher(index).authority_uid);
        assert_eq!(before.gid(), self.publisher(index).broker_gid);
        assert_eq!(before.mode() & 0o7777, 0o440);
        peer.publish_cost_settlement(output, cost);
        if lose {
            let child = self.spawn(c, index, "lost-execution", output, None);
            assert_eq!(c.advance(Some(index + 1))["ready"], false);
            self.finish(c, index, "lost-execution", child, &manifest);
            assert_eq!(c.status()["committedSteps"], index);
            // Recovery must read the retained inputs, not a mutable current prefix.
            let prefix = &self.publisher(index).prompt_prefix_path;
            let retained_prefix = fs::read(prefix).unwrap();
            protected(
                prefix,
                b"rotated live prefix must not reseal an unknown operation",
            );
            let child = self.spawn(c, index, "query", output, None);
            let report = c.advance(Some(index + 1));
            // Restore only the controlled fixture source, after query finishes.
            let result = child.wait_with_output().unwrap();
            assert!(
                result.status.success(),
                "{} {}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            protected(prefix, &retained_prefix);
            let peer = if index.is_multiple_of(2) {
                &c.author
            } else {
                &c.reviewer
            };
            self.retire_socket(peer, index);
            let observed: Value = serde_json::from_slice(
                &fs::read(
                    peer.socket_path
                        .parent()
                        .unwrap()
                        .join(format!("observed-{index}-query.json")),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(
                observed["prompt"]
                    .as_str()
                    .unwrap()
                    .contains(&serde_json::to_string(&manifest).unwrap())
            );
            assert_eq!(observed["uid"], self.publisher(index).broker_uid);
            if c.status()["committedSteps"] != index + 1 {
                for file in fs::read_dir(c.root.join("attempts")).unwrap() {
                    let path = file.unwrap().path();
                    if path.is_file() && fs::metadata(&path).unwrap().len() < 256 * 1024 {
                        eprintln!(
                            "retained attempt {}: {}",
                            path.file_name().unwrap().to_string_lossy(),
                            fs::read_to_string(&path).unwrap_or_default()
                        );
                    }
                }
            }
            assert_eq!(
                report["ready"], false,
                "unacknowledged real commit must block"
            );
        } else {
            let child = self.spawn(c, index, "execution", output, None);
            let report = c.advance(Some(index + 1));
            self.finish(c, index, "execution", child, &manifest);
            assert_eq!(
                report["ready"], false,
                "unacknowledged real commit must block"
            );
        }
        let peer = if index.is_multiple_of(2) {
            &c.author
        } else {
            &c.reviewer
        };
        assert_eq!(fs::read(&peer.request_path).unwrap(), request_bytes);
        assert_eq!(fs::metadata(&descriptor).unwrap().ino(), before.ino());
        let status = c.status();
        assert_eq!(
            status["committedSteps"],
            index + 1,
            "actual retained status: {status}; root {}",
            c.root.display()
        );
        let ack = peer.publish_commit_acknowledgement(output);
        assert_eq!(ack.actual_cost_microusd, cost);
        assert_eq!(ack.sequence, index as u64 + 1);
        let child = self.spawn(c, index, "ack", output, Some(&ack));
        let report = c.advance(Some(index + 1));
        self.finish(c, index, "ack", child, &manifest);
        assert_eq!(report["ready"], accepted, "{report}");
        manifest
    }
}
impl Drop for PublicationFixture {
    fn drop(&mut self) {
        // The private fixture root is never a host-service or production path.
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        let uid = nix::unistd::geteuid().as_raw();
        let gid = nix::unistd::getegid().as_raw();
        let restored = Command::new("sudo")
            .args([
                "-n",
                "chown",
                "-R",
                "--no-dereference",
                &format!("{uid}:{gid}"),
            ])
            .arg(&self.root)
            .status();
        if restored.is_ok_and(|s| s.success()) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

pub(super) fn run_distinct_uid_campaign() {
    {
        let mut fault = Campaign::new();
        let publisher = PublicationFixture::new(&mut fault);
        assert_eq!(fault.advance(Some(1))["ready"], false);
        let manifest = fault.capture(0);
        let operation = &fault.author.request.operation_id;
        let descriptor = publisher
            .author
            .operation_directory
            .join(format!("{operation}.json"));
        let inode = fs::metadata(&descriptor).unwrap().ino();
        let signed = fs::read(&fault.author.request_path).unwrap();
        let signed_operation = publisher
            .author
            .operation_directory
            .join(format!("{operation}.signed-request.v1"));
        assert_eq!(fs::read(&signed_operation).unwrap(), signed);
        let mut substituted = fault.author.request.clone();
        substituted.codex_runtime_identity_hash =
            hash(b"substituted runtime must not share an operation");
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        assert!(
            hepta_codex_broker::publish_product_codex_operation_v1(
                &publisher.author,
                &substituted,
                &manifest,
                now
            )
            .is_err()
        );
        assert!(
            hepta_codex_broker::recover_product_codex_prompt_hash_v1(
                &publisher.author,
                &substituted,
                &manifest
            )
            .is_err()
        );
        assert_eq!(fs::read(&signed_operation).unwrap(), signed);
        let prompt = publisher
            .author
            .operation_directory
            .join(format!("{operation}.prompt.txt"));
        protected(&prompt, b"torn protected publication");
        assert_eq!(fault.advance(Some(1))["ready"], false);
        assert_eq!(fs::read(&prompt).unwrap(), b"torn protected publication");
        assert_eq!(fs::metadata(&descriptor).unwrap().ino(), inode);
        assert_eq!(fs::read(&fault.author.request_path).unwrap(), signed);
        assert_eq!(fault.status()["committedSteps"], 0);
        assert_eq!(fault.status()["budgetRemainingMicrousd"], 100);
    }
    let mut c = Campaign::new();
    let p = PublicationFixture::new(&mut c);
    assert_ne!(p.author.authority_uid, p.author.broker_uid);
    assert_ne!(p.author.broker_uid, p.reviewer.broker_uid);
    let draft = p.stage(&mut c, 0, DRAFT, 6, true, true);
    assert_eq!(draft["objective"], c.request.objective);
    let rejected=serde_json::to_vec(&json!({"accepted":false,"manuscriptHash":hash(DRAFT),"review":"correct the unsupported claim"})).unwrap();
    let review = p.stage(&mut c, 1, &rejected, 3, false, false);
    assert_eq!(review["manuscript"], std::str::from_utf8(DRAFT).unwrap());
    assert_eq!(review["manuscriptHash"], hash(DRAFT).as_str());
    assert_eq!(c.advance(None)["ready"], false);
    assert_eq!(c.status()["amendmentCount"], 1);
    let revision = p.stage(&mut c, 2, REVISED, 7, true, false);
    assert_eq!(
        revision["previousManuscript"],
        std::str::from_utf8(DRAFT).unwrap()
    );
    assert_eq!(revision["previousManuscriptHash"], hash(DRAFT).as_str());
    assert_eq!(revision["review"], std::str::from_utf8(&rejected).unwrap());
    assert_eq!(revision["reviewHash"], hash(&rejected).as_str());
    let accepted = serde_json::to_vec(
        &json!({"accepted":true,"manuscriptHash":hash(REVISED),"review":"addressed"}),
    )
    .unwrap();
    let rereview = p.stage(&mut c, 3, &accepted, 4, true, false);
    assert_eq!(
        rereview["manuscript"],
        std::str::from_utf8(REVISED).unwrap()
    );
    assert_eq!(c.advance(None)["ready"], true);
    assert_eq!(c.status()["campaignState"], "completed");
    assert_eq!(c.status()["budgetRemainingMicrousd"], 80);
    assert_eq!(
        ObjectStoreV1::open(&c.root)
            .unwrap()
            .read(&hash(REVISED))
            .unwrap(),
        REVISED
    );
    // Ordinary replay needs neither the unavailable role sockets nor a provider.
    let before = c.status();
    assert_eq!(c.advance(None)["ready"], true);
    assert_eq!(c.status(), before);
    // No independently authenticated account qualification is fabricated here.
    assert_eq!(c.advance(None)["researchActivation"], false);
}
