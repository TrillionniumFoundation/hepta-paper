use super::*;
use crate::state_database_inventory::observe_state_database_inventory_v1;
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    value: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-schema-checkpoint-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(repo.join("rust/oracle/schema-checkpoint-v1.mjs"))
            .current_dir(repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut result = Self {
            root,
            child,
            input,
            output,
            value: Value::Null,
        };
        let reply = result.ask(json!({"operation":"fixture","root":result.root}));
        assert_eq!(reply["ok"], true, "{reply}");
        result.value = reply["value"].clone();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&result.value["profile"])
            .unwrap();
        result
    }
    fn ask(&mut self, value: Value) -> Value {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn runtime(&self) -> &Path {
        Path::new(self.value["runtimeRoot"].as_str().unwrap())
    }
    fn checkpoint(&self) -> &Path {
        Path::new(self.value["checkpointRoot"].as_str().unwrap())
    }
    fn inventory(&self) -> ObservedStateDatabaseInventoryV1 {
        observe_state_database_inventory_v1(self.runtime(), &self.value["stateDatabaseManifest"])
            .unwrap()
    }
    fn authority(&self) -> PinnedMutationAuthorityV1<NoRpc> {
        PinnedMutationAuthorityV1::load(
            Path::new(self.value["configurationPath"].as_str().unwrap()),
            self.value["configurationFileHash"].as_str().unwrap(),
            NoRpc,
        )
        .unwrap()
    }
    fn load(&self) -> Result<VerifiedSchemaTransitionCheckpointV1> {
        load_schema_transition_checkpoint_v1(
            self.checkpoint(),
            &self.inventory(),
            &self.value["writerManifest"],
            &self.authority(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
struct NoRpc;
impl MutationAuthorityTransportV1 for NoRpc {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        panic!("checkpoint authentication must not invoke authority RPC")
    }
}

#[test]
fn real_signed_original_checkpoint_survives_later_main_and_wal_changes_without_claiming_parity() {
    for wal in [false, true] {
        let mut fixture = Fixture::new();
        let original = fixture.inventory();
        let proof = fixture.load().unwrap();
        assert_eq!(
            proof.historical_inventory(),
            &fixture.value["originalInventory"]
        );
        assert_eq!(
            proof.historical_inventory()["inventoryHash"],
            fixture.value["audit"]["postInventoryHash"]
        );
        assert_eq!(
            proof.copies.iter().filter(|row| row.wal.is_some()).count(),
            0
        );
        assert_eq!(fixture.ask(json!({"operation":"validate"}))["ok"], true);
        let instance = original.value()["instances"][0].clone();
        let db = rusqlite::Connection::open(
            fixture
                .runtime()
                .join(instance["sourceRelativePath"].as_str().unwrap()),
        )
        .unwrap();
        if wal {
            db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                .unwrap();
        }
        db.execute(
            "UPDATE fixture_anchor SET value='later-unrecorded-business-state' WHERE id='fixture'",
            [],
        )
        .unwrap();
        let current = fixture.inventory();
        assert_eq!(
            current.value()["instances"][0]["walFileIdentity"].is_object(),
            wal
        );
        assert_ne!(
            current.value()["inventoryHash"],
            original.value()["inventoryHash"]
        );
        assert!(original.assert_current().is_err());
        // This proof deliberately says nothing about the changed business rows.
        // A later history verifier must reject the unrecorded modification.
        proof
            .assert_current(&current, &fixture.authority())
            .unwrap();
        fixture.load().unwrap();
        assert_eq!(
            fixture.ask(json!({"operation":"validate","current":true}))["ok"],
            false
        );
        assert!(
            verify_audit(
                &fixture.value["audit"],
                &fs::read(
                    fixture
                        .runtime()
                        .join("autonomous-research/online-schema-transition/FINAL.json")
                )
                .unwrap(),
                current.value(),
                &writer_manifest_hash_v1(&fixture.value["writerManifest"]).unwrap(),
                &fixture.authority()
            )
            .is_err()
        );
        drop(db);
    }
}

#[test]
fn checkpoint_rejects_missing_substituted_extra_and_unsafe_historical_evidence() {
    for case in [
        "missing-report",
        "missing-db",
        "later-copy",
        "extra-db",
        "extra-wal",
        "symlink-db",
        "hardlink-db",
        "fifo-db",
        "unsafe-db",
        "duplicate-json",
        "forged-inventory",
        "fake-ready-only",
        "bad-signature",
        "source-inode",
        "checkpoint-directory",
    ] {
        let mut fixture = Fixture::new();
        let report = fixture.checkpoint().join("POST_INVENTORY.json");
        let copy = fixture.checkpoint().join("databases/000.sqlite");
        let source = fixture.runtime().join(
            fixture.value["originalInventory"]["instances"][0]["sourceRelativePath"]
                .as_str()
                .unwrap(),
        );
        let authority = fixture.authority();
        let proof = fixture.load().unwrap();
        match case {
            "missing-report"=>fs::remove_file(&report).unwrap(),
            "missing-db"=>fs::remove_file(&copy).unwrap(),
            "later-copy"=> {let db=rusqlite::Connection::open(&copy).unwrap();db.execute("UPDATE fixture_anchor SET value='different'",[]).unwrap();},
            "extra-db"=>fs::write(fixture.checkpoint().join("databases/extra.sqlite"),b"extra").unwrap(),
            "extra-wal"=>fs::write(fixture.checkpoint().join("databases/000.sqlite-wal"),b"unrecorded-wal").unwrap(),
            "symlink-db"=>{fs::remove_file(&copy).unwrap();std::os::unix::fs::symlink(&source,&copy).unwrap();},
            "hardlink-db"=>{fs::remove_file(&copy).unwrap();fs::hard_link(&source,&copy).unwrap();},
            "fifo-db"=>{fs::remove_file(&copy).unwrap();nix::unistd::mkfifo(&copy,nix::sys::stat::Mode::S_IRUSR|nix::sys::stat::Mode::S_IWUSR).unwrap();},
            "unsafe-db"=>fs::set_permissions(&copy,fs::Permissions::from_mode(0o666)).unwrap(),
            "duplicate-json"=>{let text=fs::read_to_string(&report).unwrap();fs::write(&report,format!("{{\"version\":1,{}",&text[1..])).unwrap();},
            "forged-inventory"=>{let mut value=fixture.value["originalInventory"].clone();value["instances"][0]["sourceFileIdentity"]["modifiedNs"]=json!("17");fs::write(&report,serde_json::to_vec(&value).unwrap()).unwrap();},
            "fake-ready-only"=>fs::write(&report,serde_json::to_vec(&json!({"ready":true,"inventoryHash":fixture.value["audit"]["postInventoryHash"]})).unwrap()).unwrap(),
            "bad-signature"=>{assert_eq!(fixture.ask(json!({"operation":"bad-signature"}))["ok"],true);assert_eq!(fixture.ask(json!({"operation":"validate"}))["ok"],false);},
            "source-inode"=>{let next=source.with_extension("replacement");fs::copy(&source,&next).unwrap();fs::rename(next,&source).unwrap();},
            "checkpoint-directory"=>{let old=fixture.root.join("old-checkpoint");fs::rename(fixture.checkpoint(),&old).unwrap();std::os::unix::fs::symlink(old,fixture.checkpoint()).unwrap();},
            _=>unreachable!(),
        }
        let current = observe_state_database_inventory_v1(
            fixture.runtime(),
            &fixture.value["stateDatabaseManifest"],
        );
        // A source hardlink is independently refused by the live inventory.
        if let Ok(current) = current {
            assert!(
                proof.assert_current(&current, &authority).is_err(),
                "retained {case}"
            );
            assert!(
                load_schema_transition_checkpoint_v1(
                    fixture.checkpoint(),
                    &current,
                    &fixture.value["writerManifest"],
                    &authority
                )
                .is_err(),
                "load {case}"
            );
        } else {
            assert_eq!(case, "hardlink-db");
        }
    }
}
