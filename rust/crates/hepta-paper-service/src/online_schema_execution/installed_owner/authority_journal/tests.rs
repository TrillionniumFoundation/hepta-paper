//! Actual isolated filesystem effects. These tests confer no installed stop,
//! root publication, service UID isolation, or target-host qualification.
use super::*;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    parent: JournalParent,
    operation: SchemaOperationIdentityV1,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-journal-publication-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let file = File::open(&path).unwrap();
        let metadata = file.metadata().unwrap();
        let parent = JournalParent {
            path: path.clone(),
            file,
            ancestors: Vec::new(),
            identity: directory_identity(&metadata),
            uid: nix::unistd::getuid().as_raw(),
            gid: nix::unistd::getgid().as_raw(),
        };
        let operation = SchemaOperationIdentityV1 {
            runtime_root: path.clone(),
            transition_id: format!("sha256:{}", "a".repeat(64)),
            plan_hash: format!("sha256:{}", "b".repeat(64)),
            profile_sha256: format!("sha256:{}", "c".repeat(64)),
            barrier_root: path.join("barrier"),
        };
        Self { parent, operation }
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.parent.path.join(name), bytes).unwrap();
        fs::set_permissions(
            self.parent.path.join(name),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    fn intent(&self) -> Value {
        let mut family = Vec::new();
        for suffix in SUFFIXES {
            family.push(
                if self
                    .parent
                    .path
                    .join(format!("authority.sqlite{suffix}"))
                    .exists()
                {
                    SourceFile::observe(&self.parent, &format!("authority.sqlite{suffix}"), None)
                        .unwrap()
                        .descriptor
                } else {
                    Value::Null
                },
            );
        }
        json!({"sourceFamily":family,"nativeImageSha256":hash_bytes(b"isolated-native-image")})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent.path);
    }
}
#[test]
fn every_interrupted_family_retirement_is_queried_and_no_replace_publication_preserves_inodes() {
    for completed in 0..=4 {
        let fixture = Fixture::new();
        for (index, suffix) in SUFFIXES.iter().enumerate() {
            fixture.write(
                &format!("authority.sqlite{suffix}"),
                format!("physical-preimage-{index}").as_bytes(),
            );
        }
        let intent = fixture.intent();
        for index in 0..completed {
            let mut file = resolve_source(
                &fixture.parent,
                "authority.sqlite",
                &fixture.operation,
                Some(&intent),
                index,
            )
            .unwrap()
            .unwrap();
            retire_file(
                &fixture.parent,
                &mut file,
                "authority.sqlite",
                &fixture.operation,
                index,
            )
            .unwrap();
        }
        // A fresh owner queries actual namespaces after each possible crash.
        for index in 0..4 {
            let mut file = resolve_source(
                &fixture.parent,
                "authority.sqlite",
                &fixture.operation,
                Some(&intent),
                index,
            )
            .unwrap()
            .unwrap();
            assert_eq!(file.descriptor, intent["sourceFamily"][index]);
            retire_file(
                &fixture.parent,
                &mut file,
                "authority.sqlite",
                &fixture.operation,
                index,
            )
            .unwrap();
        }
        publish_native(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            b"isolated-native-image",
        )
        .unwrap();
        publish_native(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            b"isolated-native-image",
        )
        .unwrap();
        for index in 0..4 {
            let old = resolve_source(
                &fixture.parent,
                "authority.sqlite",
                &fixture.operation,
                Some(&intent),
                index,
            )
            .unwrap()
            .unwrap();
            assert_eq!(old.descriptor, intent["sourceFamily"][index]);
            assert_eq!(
                fs::read(fixture.parent.path.join(&old.name)).unwrap(),
                format!("physical-preimage-{index}").as_bytes()
            );
        }
        let native = fs::metadata(fixture.parent.path.join("authority.sqlite")).unwrap();
        assert_eq!(native.uid(), fixture.parent.uid);
        assert_eq!(native.gid(), fixture.parent.gid);
        assert_eq!(native.mode() & 0o7777, 0o600);
        assert_eq!(native.nlink(), 1);
    }
}
#[test]
fn unknown_conflicts_wrong_bytes_aliases_and_second_active_sidecars_are_never_overwritten() {
    let fixture = Fixture::new();
    fixture.write("authority.sqlite", b"original-main");
    fixture.write("authority.sqlite-wal", b"original-wal");
    let intent = fixture.intent();
    let mut old = resolve_source(
        &fixture.parent,
        "authority.sqlite",
        &fixture.operation,
        Some(&intent),
        0,
    )
    .unwrap()
    .unwrap();
    fixture.write(
        &retired("authority.sqlite", &fixture.operation, ""),
        b"unrelated-existing",
    );
    assert!(
        retire_file(
            &fixture.parent,
            &mut old,
            "authority.sqlite",
            &fixture.operation,
            0
        )
        .is_err()
    );
    assert_eq!(
        fs::read(fixture.parent.path.join("authority.sqlite")).unwrap(),
        b"original-main"
    );
    assert_eq!(
        fs::read(
            fixture
                .parent
                .path
                .join(retired("authority.sqlite", &fixture.operation, ""))
        )
        .unwrap(),
        b"unrelated-existing"
    );
    assert!(
        resolve_source(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            Some(&intent),
            0
        )
        .is_err()
    );
    assert!(
        publish_native(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            b"isolated-native-image"
        )
        .is_err()
    );
    let stage = format!(
        ".authority.sqlite.native-{}.staged",
        fixture
            .operation
            .transition_id
            .trim_start_matches("sha256:")
    );
    fs::remove_file(fixture.parent.path.join("authority.sqlite")).unwrap();
    fixture.write(&stage, b"incomplete-write");
    assert!(
        publish_native(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            b"isolated-native-image"
        )
        .is_err()
    );
    assert_eq!(
        fs::read(fixture.parent.path.join(&stage)).unwrap(),
        b"incomplete-write"
    );
    let fixture = Fixture::new();
    fixture.write("authority.sqlite", b"original-main");
    fixture.write("authority.sqlite-wal", b"original-wal");
    let intent = fixture.intent();
    let mut wal = resolve_source(
        &fixture.parent,
        "authority.sqlite",
        &fixture.operation,
        Some(&intent),
        1,
    )
    .unwrap()
    .unwrap();
    retire_file(
        &fixture.parent,
        &mut wal,
        "authority.sqlite",
        &fixture.operation,
        1,
    )
    .unwrap();
    fixture.write("authority.sqlite-wal", b"second-writer-wal");
    assert!(
        resolve_source(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            Some(&intent),
            1
        )
        .is_err()
    );
    fixture.write("aliased", b"unchanged");
    fs::hard_link(
        fixture.parent.path.join("aliased"),
        fixture.parent.path.join("hardlink"),
    )
    .unwrap();
    assert!(SourceFile::observe(&fixture.parent, "aliased", None).is_err());
    symlink("authority.sqlite", fixture.parent.path.join("symlink")).unwrap();
    assert!(SourceFile::observe(&fixture.parent, "symlink", None).is_err());
}
#[test]
fn captured_file_content_and_private_parent_replacement_fail_before_publication() {
    for path in [
        "/var/lib/./hepta-paper-state-authority",
        "/var/lib/../lib/hepta-paper-state-authority",
        "/var//lib/hepta-paper-state-authority",
        "/var/lib/hepta-paper-state-authority/",
    ] {
        assert!(!canonical(Path::new(path)));
    }
    assert!(canonical(Path::new("/var/lib/hepta-paper-state-authority")));
    let fixture = Fixture::new();
    fixture.write("authority.sqlite", b"same-size-original");
    let file = SourceFile::observe(&fixture.parent, "authority.sqlite", None).unwrap();
    fixture.write("authority.sqlite", b"same-size-modified");
    assert!(file.current(&fixture.parent).is_err());
    fs::set_permissions(&fixture.parent.path, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(fixture.parent.current().is_err());
    // Production constructor rejects a writable ancestor; the private fixture
    // owner above is deliberately not an installed/root authority capability.
    assert!(
        JournalParent::open(&fixture.parent.path, fixture.parent.uid, fixture.parent.gid).is_err()
    );
}

#[test]
fn interrupted_private_prefix_and_completed_stage_recover_without_overwriting_any_prefix() {
    for prefix in [0usize, 1, 7, b"isolated-native-image".len()] {
        let fixture = Fixture::new();
        let stage = format!(
            ".authority.sqlite.native-{}.staged",
            fixture
                .operation
                .transition_id
                .trim_start_matches("sha256:")
        );
        fixture.write(&stage, &b"isolated-native-image"[..prefix]);
        let inode = fs::metadata(fixture.parent.path.join(&stage))
            .unwrap()
            .ino();
        let ready = prepare_native_stage(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            b"isolated-native-image",
        )
        .unwrap()
        .unwrap();
        assert_eq!(ready.descriptor["inode"], inode);
        // Simulate a crash after fsync/chown and before the no-replace rename.
        drop(ready);
        publish_native(
            &fixture.parent,
            "authority.sqlite",
            &fixture.operation,
            b"isolated-native-image",
        )
        .unwrap();
        assert_eq!(
            fs::read(fixture.parent.path.join("authority.sqlite")).unwrap(),
            b"isolated-native-image"
        );
        assert_eq!(
            fs::metadata(fixture.parent.path.join("authority.sqlite"))
                .unwrap()
                .ino(),
            inode
        );
    }
}
