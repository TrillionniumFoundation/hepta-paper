use super::*;
use std::{
    fs::{DirBuilder, OpenOptions, Permissions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink},
    time::{Duration, SystemTime},
};

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = fs::canonicalize(std::env::temp_dir()).expect("real temporary directory");
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).expect("fixture randomness");
        let root = temporary.join(format!(
            "hepta-strict-reconciliation-files-{}-{}",
            std::process::id(),
            hex::encode(nonce)
        ));
        Self::directory(&root);
        Self { root }
    }

    fn directory(path: &Path) {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .expect("new owned directory");
        fs::set_permissions(path, Permissions::from_mode(0o700)).expect("exact directory mode");
    }

    fn write(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .expect("new owned file");
        file.set_permissions(Permissions::from_mode(0o600))
            .expect("exact leaf mode");
        file.write_all(bytes).expect("fixture bytes");
    }

    fn receipt_path(&self) -> PathBuf {
        self.root
            .join("strict-full-auto-acceptance")
            .join("machine-intake-reconciliation.json")
    }

    fn inspect(&self) -> Value {
        inspect_strict_machine_intake_reconciliation_v1(
            &self.root,
            None,
            None,
            &Value::Null,
            1_767_225_600_000,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn assert_missing(report: &Value) {
    assert_eq!(report["ready"], false);
    assert_eq!(report["receipt"], Value::Null);
    assert_eq!(report["statusReadOnly"], true);
    assert_eq!(
        report["status"],
        "autonomous_research_strict_machine_intake_reconciliation_blocked"
    );
    assert_eq!(
        report["blockers"],
        json!(["autonomous_research_strict_machine_intake_receipt_missing_or_invalid"])
    );
    assert_eq!(report["inspectedAt"], "2026-01-01T00:00:00.000Z");
}

#[test]
fn bounded_reader_filesystem_guards() {
    let fixture = Fixture::new();
    let exact = fixture.root.join("exact.json");
    Fixture::write(&exact, &vec![b' '; MAXIMUM_RECEIPT_BYTES as usize]);
    let observation = ObservedReceiptFile::read(&exact).expect("inclusive 2 MiB boundary");
    assert_eq!(observation.bytes.len() as u64, MAXIMUM_RECEIPT_BYTES);
    observation.assert_current().expect("unchanged actual file");
    drop(observation);

    let excessive = fixture.root.join("excessive.json");
    Fixture::write(&excessive, &vec![b' '; MAXIMUM_RECEIPT_BYTES as usize + 1]);
    assert!(ObservedReceiptFile::read(&excessive).is_err());
    let tiny = fixture.root.join("tiny.json");
    Fixture::write(&tiny, b"0");
    assert!(ObservedReceiptFile::read(&tiny).is_err());
    let minimum = fixture.root.join("minimum.json");
    Fixture::write(&minimum, b"{}");
    assert_eq!(
        ObservedReceiptFile::read(&minimum)
            .expect("inclusive two-byte minimum")
            .bytes,
        b"{}"
    );

    let leaf_link = fixture.root.join("leaf-link.json");
    symlink(&minimum, &leaf_link).expect("owned leaf symlink");
    assert!(ObservedReceiptFile::read(&leaf_link).is_err());
    let ancestor = fixture.root.join("ancestor");
    Fixture::directory(&ancestor);
    Fixture::write(&ancestor.join("receipt.json"), b"{}");
    let ancestor_link = fixture.root.join("ancestor-link");
    symlink(&ancestor, &ancestor_link).expect("owned ancestor symlink");
    assert!(ObservedReceiptFile::read(&ancestor_link.join("receipt.json")).is_err());

    let fifo = fixture.root.join("fifo.json");
    nix::unistd::mkfifo(&fifo, Mode::from_bits_truncate(0o600)).expect("owned FIFO");
    fs::set_permissions(&fifo, Permissions::from_mode(0o600)).expect("exact FIFO mode");
    // No writer is opened: the producer must use its nonblocking leaf open and
    // reject the actual FIFO type before attempting a content read.
    assert!(ObservedReceiptFile::read(&fifo).is_err());
    for mode in [0o620, 0o602, 0o622] {
        fs::set_permissions(&minimum, Permissions::from_mode(mode)).expect("writable leaf mode");
        assert!(ObservedReceiptFile::read(&minimum).is_err());
        assert_eq!(fs::read(&minimum).expect("unchanged source bytes"), b"{}");
    }
    assert!(ObservedReceiptFile::read(&ancestor).is_err());
}

#[test]
fn retained_reader_rejects_leaf_and_parent_replacement() {
    let fixture = Fixture::new();
    let original = fixture.root.join("receipt.json");
    Fixture::write(&original, b"{}");
    let held = ObservedReceiptFile::read(&original).expect("retain original leaf");
    let original_inode = fs::metadata(&original).expect("original metadata").ino();
    let retired = fixture.root.join("retired.json");
    fs::rename(&original, &retired).expect("move owned original leaf");
    Fixture::write(&original, b"[]");
    assert_ne!(
        fs::metadata(&original).expect("replacement metadata").ino(),
        original_inode
    );
    assert!(held.assert_current().is_err());
    assert_eq!(fs::read(&original).expect("replacement unchanged"), b"[]");
    assert_eq!(fs::read(&retired).expect("original unchanged"), b"{}");
    drop(held);

    let parent = fixture.root.join("parent");
    Fixture::directory(&parent);
    let path = parent.join("receipt.json");
    Fixture::write(&path, b"{}");
    let held = ObservedReceiptFile::read(&path).expect("retain original parent and leaf");
    let retired_parent = fixture.root.join("retired-parent");
    fs::rename(&parent, &retired_parent).expect("move owned original parent");
    Fixture::directory(&parent);
    Fixture::write(&path, b"[]");
    assert!(held.assert_current().is_err());
    assert_eq!(fs::read(&path).expect("replacement tree unchanged"), b"[]");
    assert_eq!(
        fs::read(retired_parent.join("receipt.json")).expect("original tree unchanged"),
        b"{}"
    );
}

#[test]
fn same_inode_same_length_change_is_detected() {
    let fixture = Fixture::new();
    let path = fixture.root.join("receipt.json");
    Fixture::write(&path, b"{}");
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let mut writer = OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("owned in-place writer");
    writer.set_modified(old_time).expect("initial known mtime");
    let held = ObservedReceiptFile::read(&path).expect("original content observation");
    let before = fs::metadata(&path).expect("before metadata");
    writer
        .write_all(b"[]")
        .expect("actual same-inode content change");
    // Ensure deterministic timestamp distinction without relying on clock tick
    // resolution or changing mode to mask missing content-change observation.
    writer
        .set_modified(old_time + Duration::from_secs(2))
        .expect("distinct content mtime");
    drop(writer);
    let after = fs::metadata(&path).expect("after metadata");
    assert_eq!(before.ino(), after.ino());
    assert_eq!(before.dev(), after.dev());
    assert_eq!(before.len(), after.len());
    assert_eq!(before.mode(), after.mode());
    assert_eq!(after.mode() & 0o777, 0o600);
    assert_eq!(fs::read(&path).expect("actual changed bytes"), b"[]");
    assert!(held.assert_current().is_err());
}

#[test]
fn public_inspection_refusals_preserve_owned_source() {
    let fixture = Fixture::new();
    let path = fixture.receipt_path();
    assert_missing(&fixture.inspect());
    assert!(!path.exists());
    assert!(!path.parent().expect("receipt parent").exists());
    Fixture::directory(path.parent().expect("receipt parent"));

    for (bytes, mode) in [
        (b"{\n".to_vec(), 0o600),
        (b"{}".to_vec(), 0o622),
        (vec![b' '; MAXIMUM_RECEIPT_BYTES as usize + 1], 0o600),
    ] {
        Fixture::write(&path, &bytes);
        fs::set_permissions(&path, Permissions::from_mode(mode)).expect("test leaf permissions");
        let before = fs::metadata(&path).expect("before metadata");
        assert_missing(&fixture.inspect());
        let after = fs::metadata(&path).expect("after metadata");
        assert_eq!(fs::read(&path).expect("unchanged actual bytes"), bytes);
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.mode(), after.mode());
        assert_eq!(before.len(), after.len());
        assert_eq!(before.mtime(), after.mtime());
        assert_eq!(before.mtime_nsec(), after.mtime_nsec());
        assert_eq!(before.ctime(), after.ctime());
        assert_eq!(before.ctime_nsec(), after.ctime_nsec());
        fs::remove_file(&path).expect("remove own case");
    }

    let target = fixture.root.join("symlink-target.json");
    Fixture::write(&target, b"{}\n");
    symlink(&target, &path).expect("owned receipt symlink");
    assert_missing(&fixture.inspect());
    assert_eq!(fs::read_link(&path).expect("symlink unchanged"), target);
    assert_eq!(
        fs::read(&target).expect("symlink target unchanged"),
        b"{}\n"
    );
    fs::remove_file(&path).expect("remove own symlink");
    nix::unistd::mkfifo(&path, Mode::from_bits_truncate(0o600)).expect("owned receipt FIFO");
    fs::set_permissions(&path, Permissions::from_mode(0o600)).expect("exact FIFO mode");
    let before = fs::symlink_metadata(&path).expect("FIFO before");
    assert_missing(&fixture.inspect());
    let after = fs::symlink_metadata(&path).expect("FIFO after");
    assert_eq!(before.ino(), after.ino());
    assert_eq!(before.mode(), after.mode());
    fs::remove_file(&path).expect("remove own FIFO");

    let parent = path.parent().expect("receipt parent");
    let retired = fixture.root.join("retired-parent");
    fs::rename(parent, &retired).expect("move owned parent");
    Fixture::write(&retired.join("machine-intake-reconciliation.json"), b"{\n");
    symlink(&retired, parent).expect("owned ancestor symlink");
    assert_missing(&fixture.inspect());
    assert_eq!(
        fs::read_link(parent).expect("ancestor link unchanged"),
        retired
    );
    assert_eq!(
        fs::read(retired.join("machine-intake-reconciliation.json"))
            .expect("retired source unchanged"),
        b"{\n"
    );
}
