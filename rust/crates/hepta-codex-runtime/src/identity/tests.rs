use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::{self, File},
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_protocol::Sha256Digest;

use super::{
    CredentialMaterialStatus, RuntimeIdentityError, RuntimeIdentityPolicyV1,
    inspect_codex_runtime_identity,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempTree(PathBuf);

impl TempTree {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "hepta-codex-runtime-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&path).expect("create temp tree");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("private temp tree");
        Self(path)
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn create_file(path: &Path, mode: u32, bytes: &[u8]) {
    let mut file = File::create(path).expect("create test file");
    file.write_all(bytes).expect("write test file");
    file.sync_all().expect("sync test file");
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set test mode");
}

fn fixture() -> (TempTree, PathBuf, PathBuf, RuntimeIdentityPolicyV1) {
    let tree = TempTree::new();
    let executable = tree.0.join("codex-test");
    create_file(&executable, 0o700, b"#!/bin/sh\nexit 0\n");
    let home = tree.0.join("home");
    fs::create_dir(&home).expect("create home");
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).expect("private home");
    create_file(&home.join("config.toml"), 0o600, b"model = 'qualified'\n");
    create_file(
        &home.join("auth.json"),
        0o600,
        b"do-not-read-in-identity-code\n",
    );
    let binary_uid = fs::metadata(&executable)
        .expect("binary metadata")
        .uid();
    let home_uid = fs::metadata(&home).expect("home metadata").uid();
    (
        tree,
        executable,
        home,
        RuntimeIdentityPolicyV1::strict(binary_uid, home_uid),
    )
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
        .expect("test digest")
}

#[test]
fn inspects_private_runtime_and_metadata_only_credentials() {
    let (_tree, executable, home, policy) = fixture();
    let environment = BTreeMap::from([(
        "PATH".to_owned(),
        executable
            .parent()
            .expect("binary parent")
            .display()
            .to_string(),
    )]);
    let identity = inspect_codex_runtime_identity(
        OsStr::new("codex-test"),
        &home,
        "qualified-model",
        digest('1'),
        digest('2'),
        &environment,
        &policy,
    )
    .expect("qualified runtime identity");
    assert_eq!(identity.executable.canonical_path(), executable);
    assert_eq!(
        identity.home.credential_material[0].status,
        CredentialMaterialStatus::Present,
    );
}

#[test]
fn rejects_symlinked_executable() {
    let (tree, executable, home, policy) = fixture();
    let link = tree.0.join("codex-link");
    symlink(&executable, &link).expect("create symlink");
    let result = inspect_codex_runtime_identity(
        link.as_os_str(),
        &home,
        "qualified-model",
        digest('1'),
        digest('2'),
        &BTreeMap::new(),
        &policy,
    );
    assert_eq!(
        result,
        Err(RuntimeIdentityError::NonCanonicalOrSymlinkPath),
    );
}

#[test]
fn rejects_hardlinked_executable() {
    let (tree, executable, home, policy) = fixture();
    fs::hard_link(&executable, tree.0.join("second-link")).expect("create hard link");
    let result = inspect_codex_runtime_identity(
        executable.as_os_str(),
        &home,
        "qualified-model",
        digest('1'),
        digest('2'),
        &BTreeMap::new(),
        &policy,
    );
    assert_eq!(result, Err(RuntimeIdentityError::FileLinkCountInvalid(2)));
}

#[test]
fn rejects_group_writable_executable() {
    let (_tree, executable, home, policy) = fixture();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o720))
        .expect("weaken executable");
    let result = inspect_codex_runtime_identity(
        executable.as_os_str(),
        &home,
        "qualified-model",
        digest('1'),
        digest('2'),
        &BTreeMap::new(),
        &policy,
    );
    assert_eq!(
        result,
        Err(RuntimeIdentityError::FilePermissionsInvalid(0o720)),
    );
}

#[test]
fn rejects_group_readable_config() {
    let (_tree, executable, home, policy) = fixture();
    fs::set_permissions(
        home.join("config.toml"),
        fs::Permissions::from_mode(0o640),
    )
    .expect("weaken config");
    let result = inspect_codex_runtime_identity(
        executable.as_os_str(),
        &home,
        "qualified-model",
        digest('1'),
        digest('2'),
        &BTreeMap::new(),
        &policy,
    );
    assert_eq!(
        result,
        Err(RuntimeIdentityError::FilePermissionsInvalid(0o640)),
    );
}

#[test]
fn rejects_symlinked_credential_material() {
    let (tree, executable, home, policy) = fixture();
    fs::remove_file(home.join("auth.json")).expect("remove credential fixture");
    let outside = tree.0.join("outside-auth.json");
    create_file(&outside, 0o600, b"opaque\n");
    symlink(&outside, home.join("auth.json")).expect("symlink credential");
    let result = inspect_codex_runtime_identity(
        executable.as_os_str(),
        &home,
        "qualified-model",
        digest('1'),
        digest('2'),
        &BTreeMap::new(),
        &policy,
    );
    assert_eq!(
        result,
        Err(RuntimeIdentityError::CredentialMaterialInvalid(
            "auth.json".to_owned(),
        )),
    );
}

#[test]
fn rejects_group_readable_codex_home() {
    let (_tree, executable, home, policy) = fixture();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o750)).expect("weaken home");
    let result = inspect_codex_runtime_identity(
        executable.as_os_str(),
        &home,
        "qualified-model",
        digest('1'),
        digest('2'),
        &BTreeMap::new(),
        &policy,
    );
    assert_eq!(
        result,
        Err(RuntimeIdentityError::HomePermissionsInvalid(0o750)),
    );
}
