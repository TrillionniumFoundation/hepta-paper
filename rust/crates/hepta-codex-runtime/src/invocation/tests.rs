use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File},
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_protocol::{SandboxPolicy, Sha256Digest};

use crate::{
    CodexRuntimeIdentityV1, RestrictedEnvironmentV1, RuntimeIdentityPolicyV1,
    codex_parent_environment_policy_v1, inspect_codex_runtime_identity,
    model_child_environment_policy_v1,
};

use super::builder::raw_sha256_for_test;
use super::*;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    executable: PathBuf,
    workspace: PathBuf,
    schema: PathBuf,
    output: PathBuf,
    runtime: CodexRuntimeIdentityV1,
    parent: RestrictedEnvironmentV1,
    child: RestrictedEnvironmentV1,
    schema_hash: Sha256Digest,
    owner_uid: u32,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "hepta-codex-invocation-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&root).expect("create root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("private root");
        let executable = root.join("codex-test");
        create_file(&executable, 0o700, b"#!/bin/sh\nexit 0\n");
        let home = root.join("home");
        fs::create_dir(&home).expect("create home");
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700))
            .expect("private home");
        create_file(&home.join("config.toml"), 0o600, b"model = 'test'\n");
        create_file(&home.join("auth.json"), 0o600, b"opaque\n");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).expect("create workspace");
        let schema = root.join("output.schema.json");
        create_file(&schema, 0o600, b"{\"type\":\"object\"}\n");
        let output = root.join("last-message.json");
        create_file(&output, 0o600, b"");
        let owner_uid = fs::metadata(&root).expect("root metadata").uid();
        let parent_source = [
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), home.clone().into_os_string()),
            (OsString::from("TMPDIR"), root.clone().into_os_string()),
            (OsString::from("CODEX_HOME"), home.clone().into_os_string()),
        ];
        let parent = codex_parent_environment_policy_v1()
            .build(parent_source, &BTreeMap::new())
            .expect("parent environment");
        let child_source = [
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), workspace.clone().into_os_string()),
            (OsString::from("TMPDIR"), workspace.clone().into_os_string()),
        ];
        let child = model_child_environment_policy_v1()
            .build(child_source, &BTreeMap::new())
            .expect("child environment");
        let transport_hash = raw_sha256_for_test(b"exec-jsonl-v1");
        let policy = RuntimeIdentityPolicyV1::strict(owner_uid, owner_uid);
        let runtime = inspect_codex_runtime_identity(
            executable.as_os_str(),
            &home,
            "qualified-model",
            parent.policy_hash.clone(),
            transport_hash,
            parent.as_map(),
            &policy,
        )
        .expect("runtime identity");
        let schema_hash = raw_sha256_for_test(b"{\"type\":\"object\"}\n");
        Self {
            root,
            executable,
            workspace,
            schema,
            output,
            runtime,
            parent,
            child,
            schema_hash,
            owner_uid,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn create_file(path: &Path, mode: u32, bytes: &[u8]) {
    let mut file = File::create(path).expect("create file");
    file.write_all(bytes).expect("write file");
    file.sync_all().expect("sync file");
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set mode");
}

#[test]
fn builds_only_the_qualified_noninteractive_cli_surface() {
    let fixture = Fixture::new();
    let invocation = build_codex_invocation(CodexInvocationRequestV1 {
        runtime: &fixture.runtime,
        workspace: &fixture.workspace,
        sandbox_policy: SandboxPolicy::WorkspaceWrite,
        output_schema_path: &fixture.schema,
        expected_output_schema_hash: &fixture.schema_hash,
        output_last_message_path: &fixture.output,
        parent_environment: fixture.parent.clone(),
        model_child_environment: &fixture.child,
        prompt: b"return the required JSON object".to_vec(),
        policy: CodexInvocationPolicyV1::strict(fixture.owner_uid),
    })
    .expect("qualified invocation");
    assert_eq!(invocation.process.executable, fixture.executable);
    assert_eq!(invocation.process.working_directory, fixture.workspace);
    let arguments = invocation
        .process
        .arguments
        .iter()
        .map(|value| value.to_str().expect("UTF-8 argument"))
        .collect::<Vec<_>>();
    for required in [
        "exec",
        "--strict-config",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "--output-schema",
        "--output-last-message",
    ] {
        assert!(arguments.contains(&required));
    }
    assert!(!arguments.contains(&"--ask-for-approval"));
    assert!(arguments.contains(&"approval_policy=\"never\""));
    assert!(arguments.contains(&"web_search=\"disabled\""));
    assert!(arguments.contains(&"sandbox_workspace_write.network_access=false"));
    assert_eq!(
        invocation.process.stdin.as_deref(),
        Some(b"return the required JSON object".as_slice()),
    );
}

#[test]
fn postflight_binds_schema_and_output_to_the_original_file_objects() {
    let fixture = Fixture::new();
    let invocation = build_codex_invocation(CodexInvocationRequestV1 {
        runtime: &fixture.runtime,
        workspace: &fixture.workspace,
        sandbox_policy: SandboxPolicy::ReadOnly,
        output_schema_path: &fixture.schema,
        expected_output_schema_hash: &fixture.schema_hash,
        output_last_message_path: &fixture.output,
        parent_environment: fixture.parent.clone(),
        model_child_environment: &fixture.child,
        prompt: b"review".to_vec(),
        policy: CodexInvocationPolicyV1::strict(fixture.owner_uid),
    })
    .expect("qualified invocation");
    create_file(&fixture.output, 0o600, b"{\"status\":\"ok\"}\n");
    let postflight = inspect_codex_invocation_postflight(&invocation, true)
        .expect("bound postflight output");
    assert!(postflight.output_message_bytes > 0);
    assert_eq!(postflight.output_schema_hash, fixture.schema_hash);
}

#[test]
fn rejects_schema_hash_drift_and_nonempty_output_file() {
    let fixture = Fixture::new();
    let wrong_hash = raw_sha256_for_test(b"wrong schema");
    let result = build_codex_invocation(CodexInvocationRequestV1 {
        runtime: &fixture.runtime,
        workspace: &fixture.workspace,
        sandbox_policy: SandboxPolicy::ReadOnly,
        output_schema_path: &fixture.schema,
        expected_output_schema_hash: &wrong_hash,
        output_last_message_path: &fixture.output,
        parent_environment: fixture.parent.clone(),
        model_child_environment: &fixture.child,
        prompt: b"review".to_vec(),
        policy: CodexInvocationPolicyV1::strict(fixture.owner_uid),
    });
    assert!(matches!(
        result,
        Err(CodexInvocationError::OutputSchemaHashMismatch),
    ));

    create_file(&fixture.output, 0o600, b"stale");
    let result = build_codex_invocation(CodexInvocationRequestV1 {
        runtime: &fixture.runtime,
        workspace: &fixture.workspace,
        sandbox_policy: SandboxPolicy::ReadOnly,
        output_schema_path: &fixture.schema,
        expected_output_schema_hash: &fixture.schema_hash,
        output_last_message_path: &fixture.output,
        parent_environment: fixture.parent.clone(),
        model_child_environment: &fixture.child,
        prompt: b"review".to_vec(),
        policy: CodexInvocationPolicyV1::strict(fixture.owner_uid),
    });
    assert!(matches!(
        result,
        Err(CodexInvocationError::OutputMessageFileNotEmpty),
    ));
}

#[test]
fn rejects_symlinked_control_file() {
    let fixture = Fixture::new();
    let link = fixture.root.join("schema-link.json");
    symlink(&fixture.schema, &link).expect("schema symlink");
    let result = build_codex_invocation(CodexInvocationRequestV1 {
        runtime: &fixture.runtime,
        workspace: &fixture.workspace,
        sandbox_policy: SandboxPolicy::ReadOnly,
        output_schema_path: &link,
        expected_output_schema_hash: &fixture.schema_hash,
        output_last_message_path: &fixture.output,
        parent_environment: fixture.parent.clone(),
        model_child_environment: &fixture.child,
        prompt: b"review".to_vec(),
        policy: CodexInvocationPolicyV1::strict(fixture.owner_uid),
    });
    assert!(matches!(
        result,
        Err(CodexInvocationError::ControlPathNonCanonical(
            "output_schema",
        )),
    ));
}
