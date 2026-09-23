use super::*;
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::process::{Command, Stdio};
fn oracle(input: Value) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("node")
        .arg(root.join("oracle/online-runtime-activation-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node 22 oracle");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input.to_string().as_bytes())
        .expect("input");
    let output = child.wait_with_output().expect("oracle exit");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("oracle JSON")
}
struct Temp {
    root: PathBuf,
}
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-activation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn instance(&self, role: &str, mode: u32) -> Value {
        let file = self.root.join("state.sqlite");
        let database = rusqlite::Connection::open(&file).unwrap();
        database
            .execute_batch(
                "CREATE TABLE state(value TEXT NOT NULL); INSERT INTO state VALUES('test');",
            )
            .unwrap();
        drop(database);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
        json!({"role":role,"sourceRelativePath":"state.sqlite","sourceFileIdentity":oracle(json!({"mode":"identity","path":file}))})
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn actual_database_opening_role_permissions_and_changed_identity_match_node() {
    for (role, mode) in [
        ("resident-instance", 0o600),
        ("submission-handoff", 0o660),
        ("resident-instance", 0o660),
        ("submission-handoff", 0o662),
    ] {
        let t = Temp::new();
        let instance = t.instance(role, mode);
        let result = open_live_activation_database_with_hook_v1(&t.root, &instance, || {});
        let actual = match result {
            Ok(_) => json!({"opened":true}),
            Err(e) => json!({"error":e.code}),
        };
        let mut expected = oracle(json!({"mode":"open","runtimeRoot":t.root,"instance":instance}));
        expected.as_object_mut().unwrap().remove("inspection");
        assert_eq!(actual, expected, "{role} {mode:o}");
    }
    for kind in ["missing", "identity", "symlink", "outside"] {
        let t = Temp::new();
        let mut instance = t.instance("resident-instance", 0o600);
        match kind {
            "missing" => instance["sourceRelativePath"] = json!("missing.sqlite"),
            "identity" => instance["sourceFileIdentity"]["inode"] = json!("0"),
            "symlink" => {
                std::fs::rename(t.root.join("state.sqlite"), t.root.join("other.sqlite")).unwrap();
                symlink("other.sqlite", t.root.join("state.sqlite")).unwrap();
            }
            _ => instance["sourceRelativePath"] = json!("../outside.sqlite"),
        };
        let code = open_live_activation_database_with_hook_v1(&t.root, &instance, || {})
            .err()
            .unwrap()
            .code;
        assert_eq!(
            json!({"error":code}),
            oracle(json!({"mode":"open","runtimeRoot":t.root,"instance":instance})),
            "{kind}"
        );
    }
}
#[test]
fn live_database_guards_reject_rebinding_without_exposing_connection_callbacks() {
    for kind in ["replace", "chmod", "symlink", "parent"] {
        let t = Temp::new();
        let instance = t.instance("resident-instance", 0o600);
        let result =
            open_live_activation_database_with_hook_v1(&t.root, &instance, || match kind {
                "replace" => {
                    std::fs::rename(t.root.join("state.sqlite"), t.root.join("old.sqlite"))
                        .unwrap();
                    std::fs::copy(t.root.join("old.sqlite"), t.root.join("state.sqlite")).unwrap();
                }
                "chmod" => std::fs::set_permissions(
                    t.root.join("state.sqlite"),
                    std::fs::Permissions::from_mode(0o644),
                )
                .unwrap(),
                "symlink" => {
                    std::fs::rename(t.root.join("state.sqlite"), t.root.join("old.sqlite"))
                        .unwrap();
                    symlink("old.sqlite", t.root.join("state.sqlite")).unwrap();
                }
                _ => {
                    let moved = t.root.with_extension("moved");
                    std::fs::rename(&t.root, &moved).unwrap();
                    std::fs::create_dir(&t.root).unwrap();
                    std::fs::rename(moved.join("state.sqlite"), t.root.join("state.sqlite"))
                        .unwrap();
                    std::fs::remove_dir(moved).unwrap();
                }
            });
        assert!(result.is_err(), "{kind}");
    }
    let t = Temp::new();
    let instance = t.instance("resident-instance", 0o600);
    let db = open_live_activation_database_with_hook_v1(&t.root, &instance, || {}).unwrap();
    assert_eq!(db.snapshot, instance["sourceFileIdentity"]);
    db.assert_current().unwrap();
    std::fs::rename(t.root.join("state.sqlite"), t.root.join("old.sqlite")).unwrap();
    std::fs::copy(t.root.join("old.sqlite"), t.root.join("state.sqlite")).unwrap();
    assert!(db.assert_current().is_err());
}
