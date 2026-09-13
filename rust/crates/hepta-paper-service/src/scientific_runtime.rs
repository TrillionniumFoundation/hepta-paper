//! Rust-owned execution of exact, operator-selected scientific programs.
//!
//! This is a trusted-local process adapter, not a hostile-code sandbox. The
//! profile pins the complete job and explicitly inventoried runtime files. No
//! credentials are inherited,
//! no shell is used and no campaign writer is opened. The service owns admission,
//! durable dispatch intent, ambiguity handling, CAS insertion and commit.

use hepta_codex_protocol::Sha256Digest;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process,
};
use nix::fcntl::OFlag;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};
use thiserror::Error;

const MAX_INPUT: usize = 512 * 1024;
const MAX_OUTPUT: usize = 512 * 1024;
const MAX_LOG: u64 = 64 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Tool selection is profile-owned; requests cannot select an executable/argv.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScientificRuntimeKindV1 {
    PythonEmpirical,
    PythonNumerical,
    REmpirical,
    RNumerical,
    Lean,
    PdfLatex,
}
impl ScientificRuntimeKindV1 {
    /// Business capability whose source execution this profile implements.
    pub const fn capability(self) -> &'static str {
        match self {
            Self::PythonEmpirical | Self::REmpirical => "CAP-EMPIRICAL",
            Self::PythonNumerical | Self::RNumerical => "CAP-NUMERICAL",
            Self::Lean => "CAP-FORMAL",
            Self::PdfLatex => "CAP-BUILD",
        }
    }
    fn entry(self) -> &'static str {
        match self {
            Self::PythonEmpirical | Self::PythonNumerical => "main.py",
            Self::REmpirical | Self::RNumerical => "main.R",
            Self::Lean => "main.lean",
            Self::PdfLatex => "main.tex",
        }
    }
    fn arguments(self) -> Vec<OsString> {
        let args: &[&str] = match self {
            Self::PythonEmpirical | Self::PythonNumerical => &["-I", "-B", "main.py"],
            Self::REmpirical | Self::RNumerical => &["--vanilla", "main.R"],
            Self::Lean => &["-o", "proof.olean", "main.lean"],
            Self::PdfLatex => &[
                "-fmt=pdflatex",
                "-progname=pdflatex",
                "-no-parse-first-line",
                "-cnf-line=openin_any=p",
                "-cnf-line=openout_any=p",
                "-no-shell-escape",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                "-jobname=paper",
                "main.tex",
            ],
        };
        args.iter().map(OsString::from).collect()
    }
}

/// Exact local invocation policy. Hash this file in WorkerBindingV1.code_files.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScientificRuntimeProfileV1 {
    pub version: u16,
    pub runtime: ScientificRuntimeKindV1,
    pub executable: PathBuf,
    pub executable_hash: Sha256Digest,
    /// Additional operator-selected regular runtime/library/configuration files.
    /// This is an explicit inventory, not automatic transitive closure discovery.
    pub runtime_files: BTreeMap<PathBuf, Sha256Digest>,
    /// Hash of the entire closed job, including inputs and requested outputs.
    pub job_hash: Sha256Digest,
    /// Existing canonical private directory. Each call creates a new child.
    pub scratch_root: PathBuf,
    /// Total execution wall-clock budget across all compiler passes.
    pub timeout_ms: u64,
    pub maximum_output_bytes: usize,
    /// Exactly one except for PdfLatex, which permits one to three passes.
    pub passes: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScientificOutputFormatV1 {
    Bytes,
    Utf8,
    Json,
    Pdf,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScientificOutputV1 {
    pub path: String,
    pub format: ScientificOutputFormatV1,
}
/// UTF-8 source/data inputs and explicit output contracts; no executable or argv.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScientificJobV1 {
    pub version: u16,
    pub files: BTreeMap<String, String>,
    pub outputs: Vec<ScientificOutputV1>,
}
#[derive(Debug)]
pub struct ScientificPreparedV1 {
    /// First artifact is a name-to-content-hash manifest, followed by exact bytes.
    pub artifacts: Vec<Vec<u8>>,
    /// Content/provenance only; not independent scientific or production evidence.
    pub evidence: Value,
}
#[derive(Debug, Error)]
pub enum ScientificRuntimeError {
    #[error("scientific execution contract or capability rejected")]
    Contract,
    #[error("scientific input/runtime identity or path rejected")]
    Identity,
    #[error("scientific execution failed, exceeded limits or requires reconciliation")]
    Execution,
    #[error("scientific output missing, malformed, unsafe or over limit")]
    Output,
    #[error("scientific private filesystem operation failed")]
    Filesystem,
}
type Result<T> = std::result::Result<T, ScientificRuntimeError>;

/// Canonical typed job hash; BTreeMap ordering is independent of JSON key order.
pub fn scientific_job_hash_v1(job: &ScientificJobV1) -> Result<Sha256Digest> {
    digest(&serde_json::to_vec(job).map_err(|_| ScientificRuntimeError::Contract)?)
}
fn digest(bytes: &[u8]) -> Result<Sha256Digest> {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        .parse()
        .map_err(|_| ScientificRuntimeError::Identity)
}
pub(crate) fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.is_ascii()
        && value.split('/').all(|c| {
            !c.is_empty()
                && c != "."
                && c != ".."
                && !c.starts_with('.')
                && c.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
fn private_directory(path: &Path) -> Result<u32> {
    let m = fs::symlink_metadata(path).map_err(|_| ScientificRuntimeError::Filesystem)?;
    if !path.is_absolute()
        || !m.is_dir()
        || m.mode() & 0o077 != 0
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(ScientificRuntimeError::Identity);
    }
    Ok(m.uid())
}
/// Bounded descriptor read with pre/post inode and metadata checks; never a FIFO.
fn read_regular(path: &Path, maximum: usize, private_owner: Option<u32>) -> Result<Vec<u8>> {
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
        return Err(ScientificRuntimeError::Identity);
    }
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| ScientificRuntimeError::Filesystem)?;
    let before = f
        .metadata()
        .map_err(|_| ScientificRuntimeError::Filesystem)?;
    if !before.is_file()
        || before.len() > maximum as u64
        || before.nlink() != 1
        || before.mode() & 0o022 != 0
        || private_owner.is_some_and(|uid| uid != before.uid())
    {
        return Err(ScientificRuntimeError::Identity);
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ScientificRuntimeError::Filesystem)?;
    let after = f
        .metadata()
        .map_err(|_| ScientificRuntimeError::Filesystem)?;
    let named = fs::symlink_metadata(path).map_err(|_| ScientificRuntimeError::Filesystem)?;
    if bytes.len() > maximum
        || bytes.len() as u64 != before.len()
        || identity(&before) != identity(&after)
        || identity(&after) != identity(&named)
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(ScientificRuntimeError::Identity);
    }
    Ok(bytes)
}
fn identity(m: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64, u32, u32, u64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
        m.mode(),
        m.uid(),
        m.nlink(),
    )
}
fn check_runtime(p: &ScientificRuntimeProfileV1) -> Result<()> {
    let executable = read_regular(&p.executable, 256 * 1024 * 1024, None)?;
    let mut total = executable.len();
    if digest(&executable)? != p.executable_hash {
        return Err(ScientificRuntimeError::Identity);
    }
    for (path, hash) in &p.runtime_files {
        let bytes = read_regular(path, 256 * 1024 * 1024, None)?;
        total = total
            .checked_add(bytes.len())
            .ok_or(ScientificRuntimeError::Identity)?;
        if total > 512 * 1024 * 1024 || digest(&bytes)? != *hash {
            return Err(ScientificRuntimeError::Identity);
        }
    }
    Ok(())
}
fn validate(p: &ScientificRuntimeProfileV1, job: &ScientificJobV1, capability: &str) -> Result<()> {
    if p.version != 1
        || job.version != 1
        || capability != p.runtime.capability()
        || p.timeout_ms == 0
        || p.timeout_ms > 3_600_000
        || p.maximum_output_bytes == 0
        || p.maximum_output_bytes > MAX_OUTPUT
        || p.passes == 0
        || p.passes > 3
        || (p.runtime != ScientificRuntimeKindV1::PdfLatex && p.passes != 1)
        || p.runtime_files.len() > 128
        || job.files.is_empty()
        || job.files.len() > 64
        || !job.files.contains_key(p.runtime.entry())
        || job.outputs.is_empty()
        || job.outputs.len() > 32
        || scientific_job_hash_v1(job)? != p.job_hash
    {
        return Err(ScientificRuntimeError::Contract);
    }
    let mut total = 0usize;
    let mut paths = BTreeSet::new();
    for (path, content) in &job.files {
        if !safe_relative(path) || content.len() > MAX_INPUT {
            return Err(ScientificRuntimeError::Contract);
        }
        total = total
            .checked_add(content.len())
            .ok_or(ScientificRuntimeError::Contract)?;
        paths.insert(path.as_str());
    }
    for output in &job.outputs {
        if !safe_relative(&output.path) || !paths.insert(&output.path) {
            return Err(ScientificRuntimeError::Contract);
        }
    }
    if total > MAX_INPUT
        || paths.iter().any(|a| {
            paths
                .iter()
                .any(|b| a != b && b.starts_with(&format!("{a}/")))
        })
    {
        return Err(ScientificRuntimeError::Contract);
    }
    if p.runtime == ScientificRuntimeKindV1::PdfLatex
        && !job
            .outputs
            .iter()
            .any(|o| o.path == "paper.pdf" && o.format == ScientificOutputFormatV1::Pdf)
    {
        return Err(ScientificRuntimeError::Contract);
    }
    Ok(())
}

fn validate_output_bytes(format: ScientificOutputFormatV1, bytes: &[u8]) -> Result<()> {
    match format {
        ScientificOutputFormatV1::Utf8 => {
            std::str::from_utf8(bytes).map_err(|_| ScientificRuntimeError::Output)?;
        }
        ScientificOutputFormatV1::Json => {
            serde_json::from_slice::<Value>(bytes).map_err(|_| ScientificRuntimeError::Output)?;
        }
        ScientificOutputFormatV1::Pdf => {
            // Framing only: neither a full PDF parser nor a scientific verdict.
            if !bytes.starts_with(b"%PDF-") || !bytes.windows(5).any(|w| w == b"%%EOF") {
                return Err(ScientificRuntimeError::Output);
            }
        }
        ScientificOutputFormatV1::Bytes => (),
    }
    Ok(())
}

/// Execute a pinned trusted-local job and return only verified named artifacts.
///
/// Retained scratch is never reused/adopted. Direct calls do not provide durable
/// replay: invoke via the service executor for prepared-cache/ambiguity handling.
pub fn execute_scientific_job_v1(
    profile: &ScientificRuntimeProfileV1,
    job: ScientificJobV1,
    capability: &str,
) -> Result<ScientificPreparedV1> {
    validate(profile, &job, capability)?;
    let owner = private_directory(&profile.scratch_root)?;
    check_runtime(profile)?;
    let name = format!(
        "scientific-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let work = profile.scratch_root.join(name);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&work)
        .map_err(|_| ScientificRuntimeError::Filesystem)?;
    if private_directory(&work)? != owner {
        return Err(ScientificRuntimeError::Identity);
    }
    for (name, content) in &job.files {
        let path = work.join(name);
        if let Some(parent) = path.parent() {
            let mut current = work.clone();
            for part in parent
                .strip_prefix(&work)
                .map_err(|_| ScientificRuntimeError::Identity)?
                .components()
            {
                current.push(part);
                if !current.exists() {
                    fs::DirBuilder::new()
                        .mode(0o700)
                        .create(&current)
                        .map_err(|_| ScientificRuntimeError::Filesystem)?;
                }
                if private_directory(&current)? != owner {
                    return Err(ScientificRuntimeError::Identity);
                }
            }
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(path)
            .map_err(|_| ScientificRuntimeError::Filesystem)?;
        file.write_all(content.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| ScientificRuntimeError::Filesystem)?;
    }
    File::open(&work)
        .and_then(|f| f.sync_all())
        .map_err(|_| ScientificRuntimeError::Filesystem)?;
    let home = work
        .to_str()
        .ok_or(ScientificRuntimeError::Identity)?
        .to_owned();
    let environment = EnvironmentPolicyV1::new(
        "scientific-local-v1",
        ["LANG", "PATH", "HOME", "TMPDIR"],
        ["LANG", "HOME"],
    )
    .map_err(|_| ScientificRuntimeError::Contract)?
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("LANG".into(), "C.UTF-8".into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), home.clone()),
            ("TMPDIR".into(), home),
        ]),
    )
    .map_err(|_| ScientificRuntimeError::Contract)?;
    let begin = Instant::now();
    let mut runs = Vec::new();
    for pass in 0..profile.passes {
        check_runtime(profile)?;
        let elapsed = u64::try_from(begin.elapsed().as_millis())
            .map_err(|_| ScientificRuntimeError::Execution)?;
        let remaining = profile
            .timeout_ms
            .checked_sub(elapsed)
            .filter(|n| *n > 0)
            .ok_or(ScientificRuntimeError::Execution)?;
        let result = run_bounded_process(
            &BoundedProcessRequestV1 {
                executable: profile.executable.clone(),
                arguments: profile.runtime.arguments(),
                working_directory: work.clone(),
                environment: environment.clone(),
                stdin: None,
            },
            ProcessLimitsV1 {
                timeout_ms: remaining,
                termination_grace_ms: 100,
                cleanup_timeout_ms: 1000,
                maximum_stdin_bytes: 1,
                maximum_stdout_bytes: MAX_LOG,
                maximum_stderr_bytes: MAX_LOG,
                maximum_tail_bytes: MAX_LOG as usize,
                ..ProcessLimitsV1::default()
            },
        )
        .map_err(|_| ScientificRuntimeError::Execution)?;
        if result.termination_reason != ProcessTerminationReason::Exited
            || result.exit_code != Some(0)
            || !result.process_group_cleanup_verified
            || result.stdout_truncated
            || result.stderr_truncated
        {
            return Err(ScientificRuntimeError::Execution);
        }
        check_runtime(profile)?;
        if begin.elapsed().as_millis() > u128::from(profile.timeout_ms) {
            return Err(ScientificRuntimeError::Execution);
        }
        runs.push(
            json!({"pass":pass+1,"exitCode":0,"stdoutHash":result.stdout_hash,
            "stderrHash":result.stderr_hash,"stdoutBytes":result.stdout_bytes,
            "stderrBytes":result.stderr_bytes,"processGroupCleanupVerified":true}),
        );
    }
    let mut inputs = BTreeMap::new();
    for (name, content) in &job.files {
        let bytes = read_regular(&work.join(name), MAX_INPUT, Some(owner))?;
        if bytes != content.as_bytes() {
            return Err(ScientificRuntimeError::Identity);
        }
        inputs.insert(name, digest(&bytes)?);
    }
    let mut artifacts = Vec::new();
    let mut outputs = Vec::new();
    let mut total = 0usize;
    for output in &job.outputs {
        let path = work.join(&output.path);
        if !fs::canonicalize(&path)
            .map_err(|_| ScientificRuntimeError::Output)?
            .starts_with(&work)
        {
            return Err(ScientificRuntimeError::Output);
        }
        let bytes = read_regular(&path, profile.maximum_output_bytes, Some(owner))
            .map_err(|_| ScientificRuntimeError::Output)?;
        total = total
            .checked_add(bytes.len())
            .ok_or(ScientificRuntimeError::Output)?;
        if bytes.is_empty() || total > profile.maximum_output_bytes {
            return Err(ScientificRuntimeError::Output);
        }
        validate_output_bytes(output.format, &bytes)?;
        outputs.push(json!({"path":output.path,"format":output.format,
            "sha256":digest(&bytes)?,"bytes":bytes.len()}));
        artifacts.push(bytes);
    }
    let manifest = json!({"version":1,"kind":"scientific_execution_manifest_v1",
        "runtime":profile.runtime,"capabilityId":capability,"jobHash":profile.job_hash,
        "executableHash":profile.executable_hash,"inputHashes":inputs,"outputs":outputs,
        "passes":runs,"scientificAcceptance":false,"productionQualified":false});
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|_| ScientificRuntimeError::Output)?;
    let evidence = json!({"version":1,"kind":"scientific_runtime_prepared_v1",
        "manifestHash":digest(&manifest_bytes)?,"runtime":profile.runtime,
        "jobHash":profile.job_hash,"scope":"trusted_local_process_not_sandbox_or_scientific_acceptance"});
    artifacts.insert(0, manifest_bytes);
    Ok(ScientificPreparedV1 {
        artifacts,
        evidence,
    })
}

/// Bounded, hash-bound profile read used by the standalone worker CLI.
pub fn read_scientific_profile_v1(
    path: &Path,
    expected: &Sha256Digest,
) -> Result<ScientificRuntimeProfileV1> {
    let bytes = read_regular(path, MAX_INPUT, None)?;
    if digest(&bytes)? != *expected {
        return Err(ScientificRuntimeError::Identity);
    }
    serde_json::from_slice(&bytes).map_err(|_| ScientificRuntimeError::Contract)
}

/// Closed output manifest used for name-based, content-verified workflow wiring.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScientificExecutionManifestV1 {
    pub version: u16,
    pub kind: String,
    pub runtime: ScientificRuntimeKindV1,
    pub capability_id: String,
    pub job_hash: Sha256Digest,
    pub executable_hash: Sha256Digest,
    pub input_hashes: BTreeMap<String, Sha256Digest>,
    pub outputs: Vec<ScientificNamedArtifactV1>,
    pub passes: Vec<ScientificPassV1>,
    pub scientific_acceptance: bool,
    pub production_qualified: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScientificNamedArtifactV1 {
    pub path: String,
    pub format: ScientificOutputFormatV1,
    pub sha256: Sha256Digest,
    pub bytes: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScientificPassV1 {
    pub pass: u8,
    pub exit_code: i32,
    pub stdout_hash: Sha256Digest,
    pub stderr_hash: Sha256Digest,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub process_group_cleanup_verified: bool,
}

/// Resolve a name independently of CAS hash sorting. Exactly one closed manifest
/// and its complete output set must be present in the committed prepared result.
/// This verifies membership/bytes, not the scientific claims of those bytes.
pub fn resolve_scientific_output_v1(
    objects: &crate::ObjectStoreV1,
    artifacts: &[Sha256Digest],
    name: &str,
    capability: &str,
) -> Result<Sha256Digest> {
    if !safe_relative(name) || artifacts.len() < 2 || artifacts.len() > 33 {
        return Err(ScientificRuntimeError::Output);
    }
    let members: BTreeSet<_> = artifacts.iter().map(ToString::to_string).collect();
    if members.len() != artifacts.len() {
        return Err(ScientificRuntimeError::Output);
    }
    let mut found = None;
    for hash in artifacts {
        let bytes = objects
            .read(hash)
            .map_err(|_| ScientificRuntimeError::Output)?;
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes)
            && value.get("kind").and_then(Value::as_str) == Some("scientific_execution_manifest_v1")
        {
            if found.is_some() {
                return Err(ScientificRuntimeError::Output);
            }
            let manifest: ScientificExecutionManifestV1 =
                serde_json::from_slice(&bytes).map_err(|_| ScientificRuntimeError::Output)?;
            found = Some((hash, manifest));
        }
    }
    let (manifest_hash, manifest) = found.ok_or(ScientificRuntimeError::Output)?;
    if manifest.version != 1
        || manifest.capability_id != capability
        || manifest.runtime.capability() != capability
        || manifest.scientific_acceptance
        || manifest.production_qualified
        || manifest.outputs.is_empty()
        || manifest.outputs.len() > 32
        || manifest.input_hashes.is_empty()
        || manifest.input_hashes.len() > 64
        || !manifest.input_hashes.contains_key(manifest.runtime.entry())
        || manifest.input_hashes.keys().any(|p| !safe_relative(p))
        || manifest.passes.is_empty()
        || manifest.passes.len() > 3
        || (manifest.runtime != ScientificRuntimeKindV1::PdfLatex && manifest.passes.len() != 1)
        || manifest.passes.iter().enumerate().any(|(i, p)| {
            usize::from(p.pass) != i + 1
                || p.exit_code != 0
                || !p.process_group_cleanup_verified
                || p.stdout_bytes > MAX_LOG
                || p.stderr_bytes > MAX_LOG
        })
    {
        return Err(ScientificRuntimeError::Output);
    }
    let mut names = BTreeSet::new();
    let mut claimed = BTreeSet::from([manifest_hash.to_string()]);
    let mut total = 0usize;
    let mut selected = None;
    for output in &manifest.outputs {
        if !safe_relative(&output.path)
            || manifest.input_hashes.contains_key(&output.path)
            || !names.insert(&output.path)
            || output.bytes == 0
            || output.bytes > MAX_OUTPUT
            || !members.contains(&output.sha256.to_string())
            || &output.sha256 == manifest_hash
        {
            return Err(ScientificRuntimeError::Output);
        }
        let bytes = objects
            .read(&output.sha256)
            .map_err(|_| ScientificRuntimeError::Output)?;
        total = total
            .checked_add(bytes.len())
            .ok_or(ScientificRuntimeError::Output)?;
        if bytes.len() != output.bytes || total > MAX_OUTPUT {
            return Err(ScientificRuntimeError::Output);
        }
        validate_output_bytes(output.format, &bytes)?;
        claimed.insert(output.sha256.to_string());
        if output.path == name {
            selected = Some(output.sha256.clone());
        }
    }
    if claimed != members
        || names
            .iter()
            .copied()
            .chain(manifest.input_hashes.keys())
            .any(|a| {
                names
                    .iter()
                    .copied()
                    .chain(manifest.input_hashes.keys())
                    .any(|b| a != b && b.starts_with(&format!("{a}/")))
            })
    {
        return Err(ScientificRuntimeError::Output);
    }
    selected.ok_or(ScientificRuntimeError::Output)
}

/// Hash an exact canonical regular local file; used for explicit profile setup.
pub fn scientific_file_hash_v1(path: &Path) -> Result<Sha256Digest> {
    digest(&read_regular(path, 256 * 1024 * 1024, None)?)
}
/// Read a bounded closed job for canonical job-hash setup; does not execute it.
pub fn read_scientific_job_v1(path: &Path) -> Result<ScientificJobV1> {
    let bytes = read_regular(path, 1024 * 1024, None)?;
    serde_json::from_slice(&bytes).map_err(|_| ScientificRuntimeError::Contract)
}
