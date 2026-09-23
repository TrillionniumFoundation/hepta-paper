//! Read-only status and explicitly authorized, create-once local integrity keys.
//! Only standard Ed25519 PKCS8/SPKI PEM is supported. Private bytes are never
//! serialized in reports; temporary buffers are zeroized. No rotation, repair,
//! overwrite or stale-lock recovery is performed.
mod crypto;
mod layout;
mod storage;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
use storage::*;
use thiserror::Error;
use zeroize::Zeroizing;

pub const LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT: &str =
    "build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority";
#[derive(Debug, Error)]
#[error("{0}")]
pub struct ReleaseIntegrityKeyError(pub String);
pub type Result<T> = std::result::Result<T, ReleaseIntegrityKeyError>;
fn error(value: impl Into<String>) -> ReleaseIntegrityKeyError {
    ReleaseIntegrityKeyError(value.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventV1 {
    BeforeReadFile,
    AfterReadFile,
    AfterReadDirectory,
    BeforeWriteFile,
    AfterWriteFile,
    BeforeStagingOpen,
    BeforePublish,
    BeforeLink,
    AfterPublicLink,
    AfterPrivateLink,
    BeforeCleanupFileRename,
    BeforeCleanupDirectoryRename,
}
/// Fault/race injection seam equivalent to Node's injected filesystem. Production
/// entry points use NoHooks, and the hook never receives private key bytes.
pub trait HookV1 {
    fn event(&mut self, event: EventV1, path: &Path) -> Result<()>;
}
impl<F: FnMut(EventV1, &Path) -> Result<()>> HookV1 for F {
    fn event(&mut self, event: EventV1, path: &Path) -> Result<()> {
        self(event, path)
    }
}
struct NoHooks;
impl HookV1 for NoHooks {
    fn event(&mut self, _event: EventV1, _path: &Path) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ReleaseIntegrityKeyContextV1 {
    pub runtime_root: PathBuf,
    pub asset_root: PathBuf,
    pub workspace_root: PathBuf,
    pub legacy_root: PathBuf,
    pub isolated: bool,
}
impl ReleaseIntegrityKeyContextV1 {
    pub fn from_environment(
        runtime_root: Option<&Path>,
        environment: &BTreeMap<String, String>,
    ) -> Result<Self> {
        let workspace_root =
            normalize(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))?;
        let parent = workspace_root
            .parent()
            .ok_or_else(|| error("release_integrity_workspace_root_invalid"))?;
        let legacy_parent = parent.file_name().is_some_and(|v| v == "paper_factory");
        let configured = |key: &str| {
            environment
                .get(key)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        let runtime_root = runtime_root
            .map(Path::to_owned)
            .or_else(|| configured("HEPTA_PAPER_RUNTIME_ROOT"))
            .unwrap_or_else(|| parent.join("hepta-paper-runtime/native-runtime"));
        let asset_root = configured("HEPTA_PAPER_ASSET_ROOT").unwrap_or_else(|| {
            if legacy_parent {
                parent.to_owned()
            } else {
                parent.join("hepta-paper-assets")
            }
        });
        let legacy_root = configured("PAPER_FACTORY_LEGACY_ROOT").unwrap_or_else(|| {
            if legacy_parent {
                parent.to_owned()
            } else {
                parent.join("paper_factory")
            }
        });
        Ok(Self {
            runtime_root: normalize(&runtime_root)?,
            asset_root: normalize(&asset_root)?,
            legacy_root: normalize(&legacy_root)?,
            workspace_root,
            isolated: environment
                .get("HEPTA_PAPER_RUNTIME_ISOLATED")
                .is_some_and(|v| v == "1"),
        })
    }
    fn non_isolated(&self) -> Result<()> {
        if self.isolated {
            Err(error(
                "release_integrity_key_access_forbidden_in_isolated_runtime",
            ))
        } else {
            Ok(())
        }
    }
}

/// Intentionally not Serialize or Debug. Reading retained private bytes requires
/// an explicit include_private=true call and is forbidden in isolated runtimes.
pub struct LoadedReleaseIntegrityKeyV1 {
    pub public_path: PathBuf,
    pub public_key_pem: String,
    pub public_key_fingerprint: String,
    private_path: Option<PathBuf>,
    private_pem: Option<Zeroizing<Vec<u8>>>,
}
impl LoadedReleaseIntegrityKeyV1 {
    pub fn private_path(&self) -> Option<&Path> {
        self.private_path.as_deref()
    }
    pub fn private_key_pem(&self) -> Option<&[u8]> {
        self.private_pem.as_ref().map(|v| v.as_slice())
    }
}
fn fingerprint(public: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(public)))
}
fn inspect_pair(
    context: &ReleaseIntegrityKeyContextV1,
    retain_private: bool,
    hooks: &mut dyn HookV1,
) -> Result<Option<LoadedReleaseIntegrityKeyV1>> {
    context.non_isolated()?;
    let root = safe_directory(
        &context.runtime_root,
        "release_integrity_runtime_root_unsafe",
    )?;
    let root_chain = snapshot(&root)?;
    let uid = lstat(&root)?.uid();
    let paths = Paths::new(&root);
    let Some(key_root) = lstat_optional(&paths.root)? else {
        unchanged(&root_chain)?;
        return Ok(None);
    };
    private_directory(&key_root, uid, "release_integrity_key_root_unsafe")?;
    if fs::canonicalize(&paths.root).map_err(|e| io_error(e, "realpath", &paths.root))?
        != paths.root
    {
        return Err(error("release_integrity_key_root_unsafe"));
    }
    let key_chain = snapshot(&paths.root)?;
    unchanged(&root_chain)?;
    private_chain(&key_chain, uid, "release_integrity_key_root_unsafe")?;
    let selected = names(&paths.root)?;
    hooks.event(EventV1::AfterReadDirectory, &paths.root)?;
    if selected != [PRIVATE_NAME, PUBLIC_NAME] {
        return Err(error("release_integrity_key_pair_shape_invalid"));
    }
    let private = read_key(&paths.private, 0o600, uid, hooks)?;
    let public = read_key(&paths.public, 0o444, uid, hooks)?;
    crypto::validate_pair(&private.bytes, &public.bytes)?;
    unchanged(&root_chain)?;
    private_chain(
        &key_chain,
        uid,
        "release_integrity_key_root_changed_during_read",
    )?;
    // Both files and the directory shape must still describe the pair whose
    // bytes were verified, including changes while the other file was read.
    private.assert_current()?;
    public.assert_current()?;
    if names(&paths.root)? != [PRIVATE_NAME, PUBLIC_NAME] {
        return Err(error("release_integrity_key_pair_shape_invalid"));
    }
    Ok(Some(LoadedReleaseIntegrityKeyV1 {
        public_path: paths.public,
        public_key_pem: String::from_utf8(public.bytes.to_vec())
            .map_err(|_| error("release_integrity_public_key_encoding_invalid"))?,
        public_key_fingerprint: fingerprint(&public.bytes),
        private_path: retain_private.then_some(paths.private),
        private_pem: retain_private.then_some(private.bytes),
    }))
}
fn status(
    ready: bool,
    present: bool,
    public_fingerprint: Option<&str>,
    blockers: Vec<String>,
) -> Value {
    json!({"version":1,"kind":"LocalReleaseIntegrityKeyStatus","status":if ready{"local_release_integrity_key_ready_bounded_local_profile"}else if present{"local_release_integrity_key_blocked"}else{"local_release_integrity_key_not_provisioned"},"ready":ready,"publicKeyFingerprint":public_fingerprint,"authorityLimit":LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT,"hostResidentExportableKey":true,"privateKeyRead":present,"credentialUse":if ready{"required"}else{"required_when_pair_present"},"externalKmsOrHsmClaimed":false,"fullProductionAuthorityClaimed":false,"blockers":blockers})
}
pub fn inspect_local_release_integrity_key_v1(
    context: &ReleaseIntegrityKeyContextV1,
) -> Result<Value> {
    inspect_local_release_integrity_key_with_hooks_v1(context, &mut NoHooks)
}
pub fn inspect_local_release_integrity_key_with_hooks_v1(
    context: &ReleaseIntegrityKeyContextV1,
    hooks: &mut dyn HookV1,
) -> Result<Value> {
    context.non_isolated()?;
    layout::assert_decoupled(context)?;
    Ok(match inspect_pair(context, false, hooks) {
        Ok(Some(pair)) => status(true, true, Some(&pair.public_key_fingerprint), Vec::new()),
        Ok(None) => status(
            false,
            false,
            None,
            vec!["release_integrity_key_not_provisioned".into()],
        ),
        Err(err) => status(false, true, None, vec![err.to_string()]),
    })
}
pub fn load_existing_local_release_integrity_key_v1(
    context: &ReleaseIntegrityKeyContextV1,
    include_private: bool,
) -> Result<LoadedReleaseIntegrityKeyV1> {
    load_existing_local_release_integrity_key_with_hooks_v1(context, include_private, &mut NoHooks)
}
pub fn load_existing_local_release_integrity_key_with_hooks_v1(
    context: &ReleaseIntegrityKeyContextV1,
    include_private: bool,
    hooks: &mut dyn HookV1,
) -> Result<LoadedReleaseIntegrityKeyV1> {
    if include_private {
        context.non_isolated()?;
    }
    layout::assert_decoupled(context)?;
    if include_private {
        return inspect_pair(context, true, hooks)?
            .ok_or_else(|| error("ENOENT:release_integrity_key_not_provisioned"));
    }
    let root = safe_directory(
        &context.runtime_root,
        "release_integrity_runtime_root_unsafe",
    )?;
    let root_chain = snapshot(&root)?;
    let uid = lstat(&root)?.uid();
    let paths = Paths::new(&root);
    private_directory(
        &lstat(&paths.root)?,
        uid,
        "release_integrity_key_root_unsafe",
    )?;
    let key_chain = snapshot(&paths.root)?;
    unchanged(&root_chain)?;
    private_chain(&key_chain, uid, "release_integrity_key_root_unsafe")?;
    let selected = names(&paths.root)?;
    hooks.event(EventV1::AfterReadDirectory, &paths.root)?;
    if selected != [PRIVATE_NAME, PUBLIC_NAME] {
        return Err(error("release_integrity_key_pair_shape_invalid"));
    }
    let private = lstat(&paths.private)?;
    if !private.is_file()
        || private.is_symlink()
        || private.nlink() != 1
        || private.mode() & 0o7777 != 0o600
        || private.uid() != uid
    {
        return Err(error("release_integrity_private_key_unsafe"));
    }
    let public = read_key(&paths.public, 0o444, uid, hooks)?;
    crypto::validate_public(&public.bytes)?;
    unchanged(&root_chain)?;
    private_chain(
        &key_chain,
        uid,
        "release_integrity_key_root_changed_during_read",
    )?;
    unchanged_file(&paths.private, &private)?;
    public.assert_current()?;
    if names(&paths.root)? != [PRIVATE_NAME, PUBLIC_NAME] {
        return Err(error("release_integrity_key_pair_shape_invalid"));
    }
    Ok(LoadedReleaseIntegrityKeyV1 {
        public_path: paths.public,
        public_key_pem: String::from_utf8(public.bytes.to_vec())
            .map_err(|_| error("release_integrity_public_key_encoding_invalid"))?,
        public_key_fingerprint: fingerprint(&public.bytes),
        private_path: None,
        private_pem: None,
    })
}
fn provision_report(context: &ReleaseIntegrityKeyContextV1, created: bool) -> Result<Value> {
    let mut result = inspect_local_release_integrity_key_v1(context)?;
    result["status"] = json!(if created {
        "local_release_integrity_key_provisioned"
    } else {
        "local_release_integrity_key_already_provisioned"
    });
    result["created"] = json!(created);
    Ok(result)
}
pub fn provision_local_release_integrity_key_v1(
    context: &ReleaseIntegrityKeyContextV1,
    execute: bool,
) -> Result<Value> {
    provision_local_release_integrity_key_with_hooks_v1(context, execute, &mut NoHooks)
}
pub fn provision_local_release_integrity_key_with_hooks_v1(
    context: &ReleaseIntegrityKeyContextV1,
    execute: bool,
    hooks: &mut dyn HookV1,
) -> Result<Value> {
    if !execute {
        return Err(error("release_integrity_key_provision_execute_required"));
    }
    context.non_isolated()?;
    layout::assert_decoupled(context)?;
    let root = safe_directory(
        &context.runtime_root,
        "release_integrity_runtime_root_unsafe",
    )?;
    let root_chain = snapshot(&root)?;
    let uid = lstat(&root)?.uid();
    let paths = Paths::new(&root);
    let lock = acquire_lock(&root, hooks)?;
    let mut staging: Option<PathBuf> = None;
    let mut staging_identity = None;
    let mut key_identity = None;
    let mut staged = Vec::new();
    let mut published = Vec::new();
    let operation = (|| {
        unchanged(&root_chain)?;
        if lstat_optional(&paths.root)?.is_some() {
            inspect_pair(context, false, hooks)?;
            return provision_report(context, false);
        }
        let parent = root
            .parent()
            .ok_or_else(|| error("release_integrity_runtime_root_unsafe"))?;
        let basename = root
            .file_name()
            .ok_or_else(|| error("release_integrity_runtime_root_unsafe"))?
            .to_string_lossy();
        let stage = loop {
            let candidate = parent.join(format!(
                ".{basename}.release-signing-staging-{}",
                random_hex()?
            ));
            match mkdir(&candidate, 0o700) {
                Ok(()) => break candidate,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io_error(e, "mkdtemp", &candidate)),
            }
        };
        staging = Some(stage.clone());
        let stage_id = harden_staging(&stage, uid, hooks)?;
        staging_identity = Some(stage_id);
        let stage_meta = lstat(&stage)?;
        private_directory(
            &stage_meta,
            uid,
            "release_integrity_key_staging_root_unsafe",
        )?;
        if !stage_id.matches(&stage_meta) {
            return Err(error("release_integrity_key_staging_root_unsafe"));
        }
        let (private, public) = crypto::generate()?;
        crypto::validate_pair(&private, public.as_bytes())?;
        let staged_private = stage.join(PRIVATE_NAME);
        let staged_public = stage.join(PUBLIC_NAME);
        staged.push((
            staged_private.clone(),
            write_exclusive(&staged_private, &private, 0o600, uid, hooks)?,
        ));
        drop(private);
        staged.push((
            staged_public.clone(),
            write_exclusive(&staged_public, public.as_bytes(), 0o444, uid, hooks)?,
        ));
        {
            let private = read_key(&staged_private, 0o600, uid, hooks)?;
            let public = read_key(&staged_public, 0o444, uid, hooks)?;
            crypto::validate_pair(&private.bytes, &public.bytes)?;
        }
        fsync_directory(&stage, Some(stage_id))?;
        hooks.event(EventV1::BeforePublish, &root)?;
        unchanged(&root_chain)?;
        match mkdir(&paths.root, 0o700) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                inspect_pair(context, false, hooks)?;
                if !remove_pair_directory(&stage, stage_id, &staged, hooks) {
                    return Err(error("release_integrity_key_staging_cleanup_incomplete"));
                }
                staging = None;
                return provision_report(context, false);
            }
            Err(e) => return Err(io_error(e, "mkdir", &paths.root)),
        }
        let created = lstat(&paths.root)?;
        private_directory(&created, uid, "release_integrity_key_root_unsafe")?;
        let root_id = Identity::of(&created);
        key_identity = Some(root_id);
        let key_chain = snapshot(&paths.root)?;
        unchanged(&root_chain)?;
        private_chain(
            &key_chain,
            uid,
            "release_integrity_key_root_changed_during_publish",
        )?;
        // link(2) is no-clobber. Public first; private signing authority strictly last.
        published.push(publish(
            &staged_public,
            &paths.public,
            staged[1].1,
            0o444,
            uid,
            hooks,
        )?);
        hooks.event(EventV1::AfterPublicLink, &paths.public)?;
        private_chain(
            &key_chain,
            uid,
            "release_integrity_key_root_changed_during_publish",
        )?;
        published.push(publish(
            &staged_private,
            &paths.private,
            staged[0].1,
            0o600,
            uid,
            hooks,
        )?);
        hooks.event(EventV1::AfterPrivateLink, &paths.private)?;
        fsync_directory(&paths.root, Some(root_id))?;
        if !remove_pair_directory(&stage, stage_id, &staged, hooks) {
            return Err(error("release_integrity_key_staging_cleanup_incomplete"));
        }
        staging = None;
        fsync_directory(parent, None)?;
        fsync_directory(&root, None)?;
        unchanged(&root_chain)?;
        private_chain(
            &key_chain,
            uid,
            "release_integrity_key_root_changed_during_publish",
        )?;
        inspect_pair(context, false, hooks)?;
        provision_report(context, true)
    })();
    let mut outcome = operation;
    if let Err(ref operation_error) = outcome {
        let message = operation_error.to_string();
        let mut incomplete = false;
        for (path, identity) in published.iter().rev() {
            if !remove_exact(path, *identity, hooks) {
                incomplete = true;
            }
        }
        if let Some(identity) = key_identity
            && !remove_empty_directory(&paths.root, identity, hooks)
        {
            incomplete = true;
        }
        if let (Some(stage), Some(identity)) = (&staging, staging_identity)
            && !remove_pair_directory(stage, identity, &staged, hooks)
        {
            incomplete = true;
        }
        if incomplete {
            outcome = Err(error(format!(
                "release_integrity_key_provision_rollback_incomplete:{message}"
            )));
        }
    }
    if let Err(err) = unchanged(&root_chain)
        && outcome.is_ok()
    {
        outcome = Err(err);
    }
    if !release_lock(lock, hooks) {
        return Err(error(format!(
            "release_integrity_key_lock_release_failed{}",
            match &outcome {
                Err(err) => format!(":{err}"),
                Ok(_) => String::new(),
            }
        )));
    }
    outcome
}

pub const RELEASE_INTEGRITY_KEY_USAGE: &str = "Usage: release-integrity-key --action status|provision [options]\n\n  --action status        Read-only validation of the existing local key pair (default).\n  --action provision     Create the pair once; requires --execute.\n  --execute              Explicit confirmation required only by provision.\n  --runtime-root PATH    Physically decoupled existing runtime root.\n\nProvision never rotates, repairs, or overwrites an existing or partial pair.\nThis host-resident exportable key authenticates build/archive integrity only.\nIt is not owner, academic, referee, submission, external KMS/HSM, or full-production authority.";
#[derive(Debug)]
pub struct ReleaseIntegrityKeyOutputV1 {
    pub value: Value,
    pub text: Option<String>,
    pub exit_code: i32,
}
fn arguments(argv: &[String]) -> Result<BTreeMap<String, String>> {
    let mut parsed = BTreeMap::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--" {
            return Err(error("unexpected_cli_argument_separator"));
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| error(format!("unexpected_cli_positional:{token}")))?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        if key.is_empty() {
            return Err(error("empty_cli_option"));
        }
        let boolean = ["help", "execute"].contains(&key);
        let value = if boolean {
            if inline.is_some() {
                return Err(error(format!(
                    "boolean_cli_option_does_not_take_value:--{key}"
                )));
            }
            "true"
        } else {
            if !["action", "runtime-root"].contains(&key) {
                return Err(error(format!("unknown_cli_option:--{key}")));
            }
            let selected = if let Some(value) = inline {
                value
            } else {
                index += 1;
                argv.get(index)
                    .filter(|v| !v.starts_with("--"))
                    .ok_or_else(|| error(format!("missing_cli_option_value:--{key}")))?
            };
            if selected.is_empty() {
                return Err(error(format!("empty_cli_option_value:--{key}")));
            }
            selected
        };
        if parsed.insert(key.into(), value.into()).is_some() {
            return Err(error(format!("duplicate_cli_option:--{key}")));
        }
        index += 1;
    }
    Ok(parsed)
}
pub fn release_integrity_key_cli_v1(
    argv: &[String],
    environment: &BTreeMap<String, String>,
) -> Result<ReleaseIntegrityKeyOutputV1> {
    let args = arguments(argv)?;
    if args.contains_key("help") {
        return Ok(ReleaseIntegrityKeyOutputV1 {
            value: Value::Null,
            text: Some(RELEASE_INTEGRITY_KEY_USAGE.into()),
            exit_code: 0,
        });
    }
    let action = args.get("action").map_or("status", String::as_str);
    if !["status", "provision"].contains(&action) {
        return Err(error(format!(
            "release_integrity_key_action_invalid:{action}"
        )));
    }
    if action == "status" && args.contains_key("execute") {
        return Err(error("release_integrity_key_status_execute_forbidden"));
    }
    if action == "provision" && !args.contains_key("execute") {
        return Err(error("release_integrity_key_provision_execute_required"));
    }
    if environment
        .get("HEPTA_PAPER_RUNTIME_ISOLATED")
        .is_some_and(|v| v == "1")
    {
        return Err(error(
            "release_integrity_key_access_forbidden_in_isolated_runtime",
        ));
    }
    let context = ReleaseIntegrityKeyContextV1::from_environment(
        args.get("runtime-root").map(Path::new),
        environment,
    )?;
    let value = if action == "status" {
        inspect_local_release_integrity_key_v1(&context)?
    } else {
        provision_local_release_integrity_key_v1(&context, true)?
    };
    let exit_code = if value["ready"] == true { 0 } else { 2 };
    Ok(ReleaseIntegrityKeyOutputV1 {
        value,
        text: None,
        exit_code,
    })
}
