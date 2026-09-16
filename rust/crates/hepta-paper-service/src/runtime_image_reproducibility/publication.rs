use super::*;
use nix::{
    fcntl::{OFlag, RenameFlags, open, openat, renameat2},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use std::{
    fs::{self, File},
    io::Write,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const TABLE: &str = "runtime_image_reproducibility_receipt";
const MAX: u64 = 32 * 1024 * 1024;
static COUNTER: AtomicU64 = AtomicU64::new(0);
fn canonical_output(path: &Path) -> Result<()> {
    ensure(
        path.is_absolute()
            && path
                .to_str()
                .is_some_and(|p| p.len() <= 4096 && !p.contains('\0'))
            && path.file_name().is_some()
            && path
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
        "runtime_reproducibility_receipt_path_invalid",
    )
}
fn private_parent(path: &Path, create: bool) -> Result<File> {
    canonical_output(path)?;
    let parent = path
        .parent()
        .ok_or("runtime_reproducibility_receipt_path_invalid")?;
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    let mut dir = open(Path::new("/"), flags, Mode::empty())
        .map_err(|_| Error("runtime_reproducibility_receipt_parent_unsafe".into()))?;
    for component in parent.components() {
        if let Component::Normal(component) = component {
            let name = Path::new(component);
            dir = match openat(dir.as_fd(), name, flags, Mode::empty()) {
                Ok(next) => next,
                Err(nix::errno::Errno::ENOENT) if create => {
                    mkdirat(dir.as_fd(), name, Mode::from_bits_truncate(0o700)).map_err(|_| {
                        Error("runtime_reproducibility_receipt_parent_unsafe".into())
                    })?;
                    openat(dir.as_fd(), name, flags, Mode::empty()).map_err(|_| {
                        Error("runtime_reproducibility_receipt_parent_unsafe".into())
                    })?
                }
                Err(_) => return Err("runtime_reproducibility_receipt_parent_unsafe".into()),
            };
        }
    }
    let dir = File::from(dir);
    let metadata = dir.metadata()?;
    ensure(
        metadata.uid() == nix::unistd::geteuid().as_raw() && metadata.mode() & 0o077 == 0,
        "runtime_reproducibility_receipt_parent_unsafe",
    )?;
    Ok(dir)
}
fn same_object(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
}
fn same_snapshot(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    same_object(a, b)
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn verify_parent(path: &Path, parent: &File) -> Result<()> {
    let current = path
        .parent()
        .ok_or("runtime_reproducibility_receipt_path_invalid")?;
    let held = parent.metadata()?;
    ensure(
        held.uid() == nix::unistd::geteuid().as_raw() && held.mode() & 0o077 == 0,
        "runtime_reproducibility_receipt_parent_unsafe",
    )?;
    ensure(
        fs::canonicalize(current)? == current
            && same_object(&held, &fs::symlink_metadata(current)?),
        "runtime_reproducibility_receipt_parent_changed",
    )
}
fn leaf(path: &Path) -> Result<&Path> {
    path.file_name()
        .map(Path::new)
        .ok_or_else(|| "runtime_reproducibility_receipt_path_invalid".into())
}
fn open_leaf(parent: &File, path: &Path, flags: OFlag) -> Result<File> {
    openat(
        parent.as_fd(),
        leaf(path)?,
        flags | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
        Mode::from_bits_truncate(0o600),
    )
    .map(File::from)
    .map_err(|_| "runtime_reproducibility_receipt_file_invalid".into())
}
fn safe_metadata(metadata: &fs::Metadata) -> Result<()> {
    ensure(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.uid() == nix::unistd::geteuid().as_raw()
            && metadata.mode() & 0o022 == 0
            && metadata.len() <= 256 * 1024 * 1024,
        "runtime_reproducibility_receipt_file_invalid",
    )
}
fn verify_database(path: &Path, parent: &File, held: &File) -> Result<()> {
    verify_parent(path, parent)?;
    let current = open_leaf(parent, path, OFlag::O_RDONLY)?;
    let a = held.metadata()?;
    let b = current.metadata()?;
    safe_metadata(&a)?;
    safe_metadata(&b)?;
    ensure(
        same_object(&a, &b),
        "runtime_reproducibility_receipt_database_changed",
    )
}
struct Authority {
    receipt: Value,
    bytes: Vec<u8>,
    content_hash: String,
    receipt_hash: String,
    generation: i64,
}
fn paths(receipt_path: &Path) -> Result<PathBuf> {
    canonical_output(receipt_path)?;
    let parent = receipt_path
        .parent()
        .ok_or_else(|| Error("runtime_reproducibility_receipt_path_invalid".into()))?;
    ensure(
        fs::canonicalize(parent)? == parent,
        "runtime_reproducibility_receipt_path_invalid",
    )?;
    let st = fs::metadata(parent)?;
    ensure(
        st.is_dir() && st.uid() == nix::unistd::geteuid().as_raw() && st.mode() & 0o077 == 0,
        "runtime_reproducibility_receipt_parent_unsafe",
    )?;
    let db = PathBuf::from(format!("{}.publication.sqlite", receipt_path.display()));
    for p in [
        receipt_path.to_path_buf(),
        db.clone(),
        PathBuf::from(format!("{}-journal", db.display())),
        PathBuf::from(format!("{}-wal", db.display())),
        PathBuf::from(format!("{}-shm", db.display())),
    ] {
        if p.symlink_metadata().is_ok() {
            let st = fs::symlink_metadata(&p)?;
            ensure(
                st.is_file()
                    && !st.file_type().is_symlink()
                    && st.nlink() == 1
                    && st.uid() == nix::unistd::geteuid().as_raw()
                    && st.mode() & 0o022 == 0
                    && st.len() <= 256 * 1024 * 1024,
                "runtime_reproducibility_receipt_file_invalid",
            )?;
        }
    }
    Ok(db)
}
fn authority(db: &Connection) -> Result<Option<Authority>> {
    let row:Option<(String,String,String,String,String,i64)>=db.query_row(&format!("SELECT receipt_json,receipt_content_hash,receipt_hash,issued_at,expires_at,publication_generation FROM {TABLE} WHERE singleton_id=1"),[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional()?;
    let Some((text, content_hash, receipt_hash, issued, expires, generation)) = row else {
        return Ok(None);
    };
    ensure(
        text.len() as u64 <= MAX,
        "runtime_reproducibility_receipt_authority_state_invalid",
    )?;
    let bytes = text.into_bytes();
    let receipt = parse(&bytes)?;
    ensure(
        rehash(
            "RuntimeImageReproducibilityReceipt",
            &receipt,
            "runtimeImageReproducibilityReceiptHash",
        ) && content_hash == digest(&bytes)
            && receipt["runtimeImageReproducibilityReceiptHash"] == receipt_hash
            && receipt["issuedAt"] == issued
            && receipt["expiresAt"] == expires
            && generation >= 1,
        "runtime_reproducibility_receipt_authority_state_invalid",
    )?;
    Ok(Some(Authority {
        receipt,
        bytes,
        content_hash,
        receipt_hash,
        generation,
    }))
}
fn schema(db: &Connection) -> Result<()> {
    db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS runtime_image_reproducibility_receipt(singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),receipt_json TEXT NOT NULL,receipt_content_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,publication_generation INTEGER NOT NULL CHECK(publication_generation>=1),updated_at TEXT NOT NULL) STRICT;")?;
    Ok(())
}
/// Read the authoritative row and compare its derived mirror without repairing
/// anything. The supplied live context rechecks signatures and every drift edge.
pub fn read_runtime_image_reproducibility_publication_v2(
    receipt_path: &Path,
    context: &ReceiptVerificationContext<'_>,
) -> Result<Option<Value>> {
    let candidate = PathBuf::from(format!("{}.publication.sqlite", receipt_path.display()));
    ensure(
        receipt_path.is_absolute(),
        "runtime_reproducibility_receipt_path_invalid",
    )?;
    if !candidate.try_exists()? {
        return Ok(None);
    }
    let db_path = paths(receipt_path)?;
    let parent = private_parent(receipt_path, false)?;
    let held = open_leaf(&parent, &db_path, OFlag::O_RDONLY)?;
    verify_database(&db_path, &parent, &held)?;
    let db = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    verify_database(&db_path, &parent, &held)?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
    let Some(a) = authority(&db)? else {
        verify_database(&db_path, &parent, &held)?;
        return Ok(None);
    };
    let mirror = read(receipt_path, MAX)
        .map_err(|_| Error("runtime_reproducibility_receipt_mirror_drift".into()))?;
    ensure(
        mirror == a.bytes && parse(&mirror)? == a.receipt,
        "runtime_reproducibility_receipt_mirror_drift",
    )?;
    let inspection = verify_runtime_image_reproducibility_receipt_v2(&a.receipt, context)?;
    verify_database(&db_path, &parent, &held)?;
    Ok(Some(
        json!({"receipt":a.receipt,"inspection":inspection,"receiptContentHash":a.content_hash,"publicationGeneration":a.generation}),
    ))
}
fn optional_leaf(parent: &File, path: &Path) -> Result<Option<File>> {
    match openat(
        parent.as_fd(),
        leaf(path)?,
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => {
            let file = File::from(fd);
            safe_metadata(&file.metadata()?)?;
            Ok(Some(file))
        }
        Err(nix::errno::Errno::ENOENT) => Ok(None),
        Err(_) => Err("runtime_reproducibility_receipt_file_invalid".into()),
    }
}
fn durable_mirror(path: &Path, parent: &File, bytes: &[u8]) -> Result<()> {
    durable_mirror_with_hook(path, parent, bytes, &mut |_, _| {})
}
fn durable_mirror_with_hook(
    path: &Path,
    parent: &File,
    bytes: &[u8],
    hook: &mut impl FnMut(&str, &Path),
) -> Result<()> {
    verify_parent(path, parent)?;
    let existing = optional_leaf(parent, path)?;
    let before = existing.as_ref().map(File::metadata).transpose()?;
    let temporary = PathBuf::from(format!(
        ".runtime-reproducibility-{}-{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    hook("before_create", &temporary);
    let mut file = open_leaf(
        parent,
        &temporary,
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL,
    )?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        hook("after_staging", &temporary);
        verify_parent(path, parent)?;
        let current = optional_leaf(parent, path)?
            .map(|f| f.metadata())
            .transpose()?;
        ensure(
            match (&before, &current) {
                (None, None) => true,
                (Some(a), Some(b)) => same_snapshot(a, b),
                _ => false,
            },
            "runtime_reproducibility_receipt_mirror_changed",
        )?;
        let flags = if before.is_some() {
            RenameFlags::RENAME_EXCHANGE
        } else {
            RenameFlags::RENAME_NOREPLACE
        };
        hook("before_publish", &temporary);
        renameat2(
            parent.as_fd(),
            &temporary,
            parent.as_fd(),
            leaf(path)?,
            flags,
        )
        .map_err(|_| Error("runtime_reproducibility_receipt_mirror_changed".into()))?;
        if let Some(before) = &before {
            let displaced = open_leaf(parent, &temporary, OFlag::O_RDONLY)?;
            if !same_object(before, &displaced.metadata()?) {
                // Restore a raced-in foreign entry only while the destination is
                // still the exact new file created by this invocation.
                let destination = open_leaf(parent, path, OFlag::O_RDONLY)?;
                if same_object(&file.metadata()?, &destination.metadata()?) {
                    renameat2(
                        parent.as_fd(),
                        &temporary,
                        parent.as_fd(),
                        leaf(path)?,
                        RenameFlags::RENAME_EXCHANGE,
                    )
                    .map_err(|_| Error("runtime_reproducibility_receipt_mirror_changed".into()))?;
                }
                return Err("runtime_reproducibility_receipt_mirror_changed".into());
            }
            unlinkat(parent.as_fd(), &temporary, UnlinkatFlags::NoRemoveDir)
                .map_err(|_| Error("runtime_reproducibility_receipt_mirror_changed".into()))?;
        }
        parent.sync_all()?;
        verify_parent(path, parent)?;
        let published = open_leaf(parent, path, OFlag::O_RDONLY)?;
        ensure(
            same_object(&file.metadata()?, &published.metadata()?),
            "runtime_reproducibility_receipt_mirror_changed",
        )
    })();
    if result.is_err() {
        // Never delete an entry merely because it occupies our temporary name.
        if let Ok(current) = open_leaf(parent, &temporary, OFlag::O_RDONLY)
            && matches!((file.metadata(),current.metadata()),(Ok(a),Ok(b)) if same_object(&a,&b))
        {
            let _ = unlinkat(parent.as_fd(), &temporary, UnlinkatFlags::NoRemoveDir);
        }
    }
    result
}
/// Explicitly offline publication. No externally-fenced permit is synthesized.
/// SQLite is authoritative, the atomic JSON mirror is derived. If a mirror write
/// fails after commit, the error is `...committed_mirror_pending`; retrying the
/// same still-valid receipt revalidates it and repairs the mirror idempotently.
pub fn publish_runtime_image_reproducibility_offline_v2(
    receipt_path: &Path,
    receipt: &Value,
    context: &ReceiptVerificationContext<'_>,
) -> Result<Value> {
    let inspection = verify_runtime_image_reproducibility_receipt_v2(receipt, context)?;
    ensure(
        inspection["ready"] == true
            && inspection["receiptAccepted"] == true
            && inspection["receiptHash"] == receipt["runtimeImageReproducibilityReceiptHash"],
        "runtime_reproducibility_verified_receipt_required",
    )?;
    let parent = private_parent(receipt_path, true)?;
    let db_path = paths(receipt_path)?;
    let database_file = match optional_leaf(&parent, &db_path)? {
        Some(file) => file,
        None => {
            let file = open_leaf(
                &parent,
                &db_path,
                OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL,
            )?;
            file.sync_all()?;
            parent.sync_all()?;
            file
        }
    };
    verify_database(&db_path, &parent, &database_file)?;
    let mut db = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    verify_database(&db_path, &parent, &database_file)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    schema(&db)?;
    let mut bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|_| Error("runtime_reproducibility_json_invalid".into()))?;
    bytes.push(b'\n');
    ensure(
        bytes.len() as u64 <= MAX,
        "runtime_reproducibility_receipt_file_invalid",
    )?;
    let content_hash = digest(&bytes);
    let receipt_hash = s(&receipt["runtimeImageReproducibilityReceiptHash"]);
    let issued = s(&receipt["issuedAt"]);
    let expires = s(&receipt["expiresAt"]);
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old = authority(&tx)?;
    if let Some(old) = &old {
        let identical = old.receipt_hash == receipt_hash && old.receipt["issuedAt"] == issued;
        let newer = instant(&receipt["issuedAt"])
            .zip(instant(&old.receipt["issuedAt"]))
            .is_some_and(|(a, b)| a > b)
            && instant(&receipt["expiresAt"])
                .zip(instant(&old.receipt["expiresAt"]))
                .is_some_and(|(a, b)| a > b);
        ensure(
            identical || newer,
            "runtime_reproducibility_receipt_monotonic_cas_rejected",
        )?;
    }
    let generation = match &old {
        Some(a) => a
            .generation
            .checked_add(1)
            .ok_or("runtime_reproducibility_receipt_generation_exhausted")?,
        None => 1,
    };
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| Error("runtime_reproducibility_json_invalid".into()))?;
    tx.execute("INSERT INTO runtime_image_reproducibility_receipt VALUES(1,?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(singleton_id) DO UPDATE SET receipt_json=excluded.receipt_json,receipt_content_hash=excluded.receipt_content_hash,receipt_hash=excluded.receipt_hash,issued_at=excluded.issued_at,expires_at=excluded.expires_at,publication_generation=excluded.publication_generation,updated_at=excluded.updated_at",params![text,content_hash,receipt_hash,issued,expires,generation,context.now])?;
    verify_database(&db_path, &parent, &database_file)?;
    tx.commit()?;
    // Serialize mirror reconciliation with other publishers. Status only reads and
    // therefore can report the brief committed/mirror-pending interval accurately.
    let reconciliation = (|| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let a = authority(&tx)?.ok_or_else(|| {
            Error("runtime_reproducibility_receipt_authority_state_invalid".into())
        })?;
        verify_database(&db_path, &parent, &database_file)?;
        durable_mirror(receipt_path, &parent, &a.bytes)?;
        let current_hash = a.receipt_hash;
        tx.commit()?;
        Ok::<_, Error>(current_hash)
    })();
    let mirrored = reconciliation
        .map_err(|_| Error("runtime_reproducibility_receipt_committed_mirror_pending".into()))?;
    verify_database(&db_path, &parent, &database_file)?;
    seal(
        "RuntimeImageReproducibilityReceiptPublication",
        json!({"version":2,"kind":"RuntimeImageReproducibilityReceiptPublication","status":"runtime_image_reproducibility_receipt_published","receiptPath":receipt_path,"publicationDatabasePath":db_path,"publicationGeneration":generation,"receiptHash":receipt_hash,"receiptContentHash":content_hash,"issuedAt":issued,"expiresAt":expires,"sqliteAuthorityAtomicPublication":true,"sqliteAuthorityDurablePublication":true,"sqliteMonotonicCompareAndSwap":true,"derivedJsonMirror":true,"derivedJsonMirrorCrashRecoverable":true,"crossResourceAtomicPublicationClaimed":false,"mirrorSideEffectPermitHash":null,"mirrorReconciledToReceiptHash":mirrored,"receiptRemainedCurrentAtMirrorReconciliation":mirrored==receipt_hash,"currentCodeReleaseAndInputClosureDriftMustRevalidate":true,"externalActionPerformed":false}),
        "runtimeImageReproducibilityReceiptPublicationHash",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hepta-image-publication-race-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn mirror_publishes_and_replaces_using_pinned_directory() {
        let temp = Temp::new();
        let path = temp.0.join("receipt.json");
        let parent = private_parent(&path, false).unwrap();
        durable_mirror(&path, &parent, b"first").unwrap();
        durable_mirror(&path, &parent, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }
    #[test]
    fn mirror_does_not_delete_foreign_staging_or_replace_raced_destination() {
        for event in ["before_create", "before_publish"] {
            let temp = Temp::new();
            let path = temp.0.join("receipt.json");
            fs::write(&path, b"old").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            let parent = private_parent(&path, false).unwrap();
            let foreign = temp.0.join("foreign");
            fs::write(&foreign, b"foreign").unwrap();
            fs::set_permissions(&foreign, fs::Permissions::from_mode(0o600)).unwrap();
            let mut target = None;
            let result = durable_mirror_with_hook(&path, &parent, b"new", &mut |at, stage| {
                if at == event {
                    let replacement = if at == "before_create" {
                        temp.0.join(stage)
                    } else {
                        path.clone()
                    };
                    fs::rename(&foreign, &replacement).unwrap();
                    target = Some(replacement);
                }
            });
            assert!(result.is_err(), "{event}");
            assert_eq!(fs::read(target.unwrap()).unwrap(), b"foreign", "{event}");
        }
    }
    #[test]
    fn replaced_parent_is_rejected_without_writing_replacement_tree() {
        let temp = Temp::new();
        let directory = temp.0.join("output");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("receipt.json");
        let parent = private_parent(&path, false).unwrap();
        let result = durable_mirror_with_hook(&path, &parent, b"new", &mut |event, _| {
            if event == "after_staging" {
                fs::rename(&directory, temp.0.join("displaced")).unwrap();
                fs::create_dir(&directory).unwrap();
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
                fs::write(&path, b"foreign").unwrap();
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"foreign");
        assert_eq!(fs::read_dir(temp.0.join("displaced")).unwrap().count(), 0);
    }
    #[test]
    fn replaced_database_and_changed_parent_permissions_are_rejected() {
        let temp = Temp::new();
        let path = temp.0.join("receipt.publication.sqlite");
        let parent = private_parent(&path, false).unwrap();
        let held = open_leaf(
            &parent,
            &path,
            OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL,
        )
        .unwrap();
        verify_database(&path, &parent, &held).unwrap();
        fs::rename(&path, temp.0.join("old")).unwrap();
        fs::write(&path, b"foreign").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(verify_database(&path, &parent, &held).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"foreign");
        fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o770)).unwrap();
        assert!(verify_parent(&path, &parent).is_err());
    }
}
