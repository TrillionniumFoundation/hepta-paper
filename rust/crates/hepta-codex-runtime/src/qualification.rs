use std::{ffi::OsStr, path::Path};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1,
    CodexRuntimeIdentityV1, ProcessLimitsV1, RuntimeIdentityError,
    RuntimeIdentityPolicyV1, inspect_codex_runtime_identity, run_bounded_process,
};

/// Exact identity components that changed between preflight and postflight.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentityDrift {
    pub before_identity_hash: Sha256Digest,
    pub after_identity_hash: Sha256Digest,
    pub changed_components: Vec<String>,
}

/// Inputs for one preflight -> supervised process -> postflight execution.
pub struct QualifiedRuntimeExecutionRequestV1<'a> {
    pub executable: &'a OsStr,
    pub codex_home: &'a Path,
    pub model_selector: &'a str,
    pub transport_profile_hash: Sha256Digest,
    pub identity_policy: &'a RuntimeIdentityPolicyV1,
    pub process: &'a BoundedProcessRequestV1,
    pub process_limits: ProcessLimitsV1,
}

/// Qualified runtime and process observations after a stable postflight.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualifiedRuntimeExecutionResultV1 {
    pub runtime_identity: CodexRuntimeIdentityV1,
    pub process: BoundedProcessResultV1,
}

/// Runs one bounded process between runtime-identity preflight and postflight.
pub fn run_qualified_runtime_execution(
    request: QualifiedRuntimeExecutionRequestV1<'_>,
) -> Result<QualifiedRuntimeExecutionResultV1, RuntimeExecutionError> {
    let before = inspect_for_execution(&request).map_err(RuntimeExecutionError::Preflight)?;
    validate_execution_binding(&before, request.process)?;
    let process = run_bounded_process(request.process, request.process_limits);
    let after = inspect_for_execution(&request);
    match (process, after) {
        (Ok(process), Ok(after)) => {
            verify_runtime_identity_unchanged(&before, &after)
                .map_err(RuntimeExecutionError::Qualification)?;
            Ok(QualifiedRuntimeExecutionResultV1 {
                runtime_identity: after,
                process,
            })
        }
        (Ok(_), Err(postflight)) => Err(RuntimeExecutionError::Postflight(postflight)),
        (Err(process), Ok(after)) => match verify_runtime_identity_unchanged(&before, &after) {
            Ok(()) => Err(RuntimeExecutionError::Process(process)),
            Err(RuntimeQualificationError::IdentityChanged(drift)) => {
                Err(RuntimeExecutionError::ProcessAndIdentityDrift { process, drift })
            }
        },
        (Err(process), Err(postflight)) => {
            Err(RuntimeExecutionError::ProcessAndPostflight { process, postflight })
        }
    }
}

fn inspect_for_execution(
    request: &QualifiedRuntimeExecutionRequestV1<'_>,
) -> Result<CodexRuntimeIdentityV1, RuntimeIdentityError> {
    inspect_codex_runtime_identity(
        request.executable,
        request.codex_home,
        request.model_selector,
        request.process.environment.policy_hash.clone(),
        request.transport_profile_hash.clone(),
        request.process.environment.as_map(),
        request.identity_policy,
    )
}

fn validate_execution_binding(
    runtime: &CodexRuntimeIdentityV1,
    process: &BoundedProcessRequestV1,
) -> Result<(), RuntimeExecutionError> {
    if runtime.executable.canonical_path() != process.executable.as_path() {
        return Err(RuntimeExecutionError::ProcessExecutableMismatch);
    }
    let home = runtime.home.canonical_path();
    let codex_home = process
        .environment
        .get("CODEX_HOME")
        .map(Path::new)
        .ok_or(RuntimeExecutionError::CodexHomeEnvironmentMissing)?;
    if codex_home != home {
        return Err(RuntimeExecutionError::CodexHomeEnvironmentMismatch);
    }
    let home_environment = process
        .environment
        .get("HOME")
        .map(Path::new)
        .ok_or(RuntimeExecutionError::HomeEnvironmentMissing)?;
    if home_environment != home {
        return Err(RuntimeExecutionError::HomeEnvironmentMismatch);
    }
    Ok(())
}

/// Fails closed when executable, home, credential metadata, model, or policy drifts.
pub fn verify_runtime_identity_unchanged(
    before: &CodexRuntimeIdentityV1,
    after: &CodexRuntimeIdentityV1,
) -> Result<(), RuntimeQualificationError> {
    let mut changed = Vec::new();
    if before.executable.identity_hash != after.executable.identity_hash {
        changed.push("executable".to_owned());
    }
    if before.home.root != after.home.root {
        changed.push("codex_home_root".to_owned());
    }
    if before.home.config != after.home.config
        || before.home.config_content_hash != after.home.config_content_hash
    {
        changed.push("codex_home_config".to_owned());
    }
    if before.home.credential_material != after.home.credential_material {
        changed.push("credential_material_metadata".to_owned());
    }
    if before.home.identity_hash != after.home.identity_hash {
        changed.push("codex_home_identity".to_owned());
    }
    if before.model_selector != after.model_selector {
        changed.push("model_selector".to_owned());
    }
    if before.environment_policy_hash != after.environment_policy_hash {
        changed.push("environment_policy".to_owned());
    }
    if before.transport_profile_hash != after.transport_profile_hash {
        changed.push("transport_profile".to_owned());
    }
    if before.identity_hash != after.identity_hash {
        changed.push("aggregate_runtime_identity".to_owned());
    }
    changed.sort();
    changed.dedup();
    if changed.is_empty() {
        Ok(())
    } else {
        Err(RuntimeQualificationError::IdentityChanged(RuntimeIdentityDrift {
            before_identity_hash: before.identity_hash.clone(),
            after_identity_hash: after.identity_hash.clone(),
            changed_components: changed,
        }))
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RuntimeQualificationError {
    #[error("Codex runtime identity changed during execution")]
    IdentityChanged(RuntimeIdentityDrift),
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RuntimeExecutionError {
    #[error("Codex runtime preflight failed: {0}")]
    Preflight(RuntimeIdentityError),
    #[error("process executable does not match the qualified executable identity")]
    ProcessExecutableMismatch,
    #[error("CODEX_HOME is missing from the qualified parent environment")]
    CodexHomeEnvironmentMissing,
    #[error("CODEX_HOME does not match the inspected Codex home")]
    CodexHomeEnvironmentMismatch,
    #[error("HOME is missing from the qualified parent environment")]
    HomeEnvironmentMissing,
    #[error("HOME does not match the inspected Codex home")]
    HomeEnvironmentMismatch,
    #[error("bounded process execution failed: {0}")]
    Process(BoundedProcessError),
    #[error("Codex runtime postflight failed: {0}")]
    Postflight(RuntimeIdentityError),
    #[error("Codex runtime qualification failed: {0}")]
    Qualification(RuntimeQualificationError),
    #[error("process failed and runtime identity drifted")]
    ProcessAndIdentityDrift {
        process: BoundedProcessError,
        drift: RuntimeIdentityDrift,
    },
    #[error("process and runtime postflight both failed")]
    ProcessAndPostflight {
        process: BoundedProcessError,
        postflight: RuntimeIdentityError,
    },
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        ffi::OsString,
        fs::{self, File},
        io::Write,
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::{Path, PathBuf},
        str::FromStr,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use hepta_codex_protocol::Sha256Digest;

    use crate::{
        BoundedProcessRequestV1, ProcessLimitsV1, RuntimeIdentityPolicyV1,
        codex_parent_environment_policy_v1,
    };

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        executable: PathBuf,
        home: PathBuf,
        policy: RuntimeIdentityPolicyV1,
    }

    impl Fixture {
        fn new(script: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "hepta-codex-qualification-{}-{nonce}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir(&root).expect("create fixture root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .expect("private fixture root");
            let executable = root.join("codex-test");
            create_file(&executable, 0o700, script.as_bytes());
            let home = root.join("home");
            fs::create_dir(&home).expect("create home");
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700))
                .expect("private home");
            create_file(&home.join("config.toml"), 0o600, b"model = 'one'\n");
            create_file(&home.join("auth.json"), 0o600, b"opaque\n");
            let policy = RuntimeIdentityPolicyV1::strict(
                fs::metadata(&executable).expect("binary metadata").uid(),
                fs::metadata(&home).expect("home metadata").uid(),
            );
            Self {
                root,
                executable,
                home,
                policy,
            }
        }

        fn process(&self) -> BoundedProcessRequestV1 {
            let source = [
                (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
                (OsString::from("HOME"), self.home.clone().into_os_string()),
                (OsString::from("TMPDIR"), self.root.clone().into_os_string()),
                (
                    OsString::from("CODEX_HOME"),
                    self.home.clone().into_os_string(),
                ),
            ];
            BoundedProcessRequestV1 {
                executable: self.executable.clone(),
                arguments: Vec::new(),
                working_directory: self.root.clone(),
                environment: codex_parent_environment_policy_v1()
                    .build(source, &BTreeMap::new())
                    .expect("qualified parent environment"),
                stdin: None,
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

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    #[test]
    fn stable_runtime_executes_and_passes_postflight() {
        let fixture = Fixture::new("#!/bin/sh\nexit 0\n");
        let process = fixture.process();
        let result = run_qualified_runtime_execution(QualifiedRuntimeExecutionRequestV1 {
            executable: fixture.executable.as_os_str(),
            codex_home: &fixture.home,
            model_selector: "qualified-model",
            transport_profile_hash: digest('2'),
            identity_policy: &fixture.policy,
            process: &process,
            process_limits: ProcessLimitsV1::default(),
        })
        .expect("stable qualified execution");
        assert_eq!(result.process.exit_code, Some(0));
    }

    #[test]
    fn config_drift_during_execution_is_rejected() {
        let fixture = Fixture::new(
            "#!/bin/sh\nset -eu\nprintf \"model = 'two'\\n\" > \"$CODEX_HOME/config.toml\"\nchmod 600 \"$CODEX_HOME/config.toml\"\n",
        );
        let process = fixture.process();
        let error = run_qualified_runtime_execution(QualifiedRuntimeExecutionRequestV1 {
            executable: fixture.executable.as_os_str(),
            codex_home: &fixture.home,
            model_selector: "qualified-model",
            transport_profile_hash: digest('2'),
            identity_policy: &fixture.policy,
            process: &process,
            process_limits: ProcessLimitsV1::default(),
        })
        .expect_err("runtime drift must fail qualification");
        let RuntimeExecutionError::Qualification(
            RuntimeQualificationError::IdentityChanged(drift),
        ) = error
        else {
            panic!("unexpected runtime execution error: {error:?}");
        };
        assert!(
            drift
                .changed_components
                .contains(&"codex_home_config".to_owned()),
        );
    }
}
