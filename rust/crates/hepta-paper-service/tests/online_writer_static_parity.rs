use hepta_paper_service::online_writer_static::discover_online_writer_mutation_entrypoints_v1;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
fn oracle(inputs: &[Value]) -> Vec<Value> {
    let mut child = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../oracle/online-writer-static-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!(inputs).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn compare(cases: &[Value]) {
    let expected = oracle(cases);
    for (i, (case, node)) in cases.iter().zip(expected).enumerate() {
        let actual = discover_online_writer_mutation_entrypoints_v1(
            case["path"].as_str().unwrap(),
            case["source"].as_str().unwrap(),
        )
        .unwrap_or_else(|e| json!({"error":e.code}));
        if actual != node {
            let keys = actual
                .as_object()
                .map(|o| {
                    o.keys()
                        .filter(|k| actual[*k] != node[*k])
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            panic!(
                "case {i} path {} differs in {keys:?}: native {} Node {}",
                case["path"],
                json!(
                    keys.iter()
                        .map(|k| (k, &actual[k]))
                        .collect::<std::collections::BTreeMap<_, _>>()
                ),
                json!(
                    keys.iter()
                        .map(|k| (k, &node[k]))
                        .collect::<std::collections::BTreeMap<_, _>>()
                )
            );
        }
    }
}
#[test]
fn actual_ast_and_scope_discovery_matches_node_for_aliases_shadowing_callbacks_and_syntax() {
    let path = "paper-adapters/persistence/test-writer.mjs";
    let bodies = [
        "export function write(db){db.exec('INSERT INTO records VALUES(1)');}",
        "export const write = (database) => database.exec(`UPDATE records SET value=${x}`);",
        "const text='INSERT INTO records VALUES(1)'; export function write(db){db.exec(text);}",
        "const rows='readonly'; export function read(db){return db.prepare('SELECT * FROM state').all();}",
        "function apply(tx){tx.run('statement');} export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:apply});}",
        "export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:(tx)=>tx.run('statement')});}",
        "export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:(tx)=>db.exec('INSERT INTO state VALUES(1)')});}",
        "export function write(database){const alias=database;return database.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:(tx)=>alias.prepare('SELECT 1')});}",
        "export function write(database){return database.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:(tx)=>{const alias=tx;alias.run('statement')}});}",
        "export function write(database){return database.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:(tx)=>{const database=tx;database.run('statement')}});}",
        "export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:unknown});}",
        "export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:()=>db[method]('statement')});}",
        "export function write(ctx){return ctx.writer.executeMutation({databaseRole:'native-store',operationId:'op:test',database:ctx.persistence,mutate:()=>ctx.persistence.run('statement')});}",
        "function mutate(tx){tx.run('statement');} export function outer(db){db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate});}",
        "import {createSqliteStore as open} from './sqlite-store.mjs'; export function start(){return open({});}",
        "import {createSqliteStore as open} from './sqlite-store'; export function start(){return open({});}",
        "const text='🦀';export function write(db){db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:()=>db.exec('DELETE FROM x')});}",
        "export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:({run})=>run('statement')});}",
        "export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:(tx)=>{function nested(){db.run('bad')}nested()}});}",
        "export function write(db){return db.executeMutation({databaseRole:'native-store',operationId:'op:test',mutate:(tx)=>{const alias=tx;function nested(alias){alias.run('statement')}nested(db)}});}",
        "function a(db){b(db)} function b(db){db.exec('DELETE FROM x')} export {a};",
        "class Store {write(db){return db.run('statement')}}",
        "function broken(db) { db.exec('DELETE FROM x'); ",
        "const duplicate=1; const duplicate=2; db.exec('DELETE FROM x');",
    ];
    compare(
        &bodies
            .into_iter()
            .map(|source| json!({"path":path,"source":source}))
            .collect::<Vec<_>>(),
    );
}
#[test]
fn every_production_writer_module_matches_live_node_discovery() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut cases = Vec::new();
    fn visit(root: &Path, path: &Path, cases: &mut Vec<Value>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_symlink() {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                visit(root, &path, cases)
            } else if path.extension().is_some_and(|v| v == "mjs") {
                cases.push(json!({"path":path.strip_prefix(root).unwrap().to_str().unwrap(),"source":std::fs::read_to_string(path).unwrap()}));
            }
        }
    }
    for directory in [
        "paper-adapters",
        "paper-application",
        "paper-composition",
        "paper-core/bin",
    ] {
        visit(&root, &root.join(directory), &mut cases);
    }
    assert!(cases.len() > 500);
    compare(&cases);
}
#[test]
fn repository_static_inspection_hashes_and_opaque_complete_evidence_match_node() {
    use hepta_paper_service::online_writer_static::{
        inspect_online_writer_static_coverage_v1, verify_online_writer_static_coverage_v1,
    };
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let manifest = oracle(&[json!({"mode":"manifest"})]).remove(0);
    let expected =
        oracle(&[json!({"mode":"inspect","workspaceRoot":root,"manifest":manifest})]).remove(0);
    let actual = inspect_online_writer_static_coverage_v1(&root, &manifest).unwrap();
    for key in actual.as_object().unwrap().keys() {
        assert_eq!(actual[key], expected[key], "full inspection field {key}");
    }
    if actual["status"] == "autonomous_research_online_writer_static_coverage_complete" {
        let verified = verify_online_writer_static_coverage_v1(&root, &manifest).unwrap();
        assert_eq!(verified.value(), &actual);
    } else {
        assert!(verify_online_writer_static_coverage_v1(&root, &manifest).is_err());
    }
}
#[test]
fn synthetic_complete_source_scan_rejects_changed_and_unregistered_writer_evidence() {
    use hepta_paper_service::online_writer_static::{
        inspect_online_writer_static_coverage_v1, verify_online_writer_static_coverage_v1,
    };
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let temp = Temp(
        std::env::temp_dir().join(format!("hepta-native-writer-static-{}", std::process::id())),
    );
    std::fs::create_dir(&temp.0).unwrap();
    let config: Value =
        serde_json::from_str(include_str!("../src/online_writer_static/config.json")).unwrap();
    for relative in config["PROVENANCE_ONLY_SOURCES"].as_array().unwrap() {
        let path = temp.0.join(relative.as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            "// Synthetic provenance source, not an actual runtime.\n",
        )
        .unwrap();
    }
    let mut child = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/online-runtime-activation-v1.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"mode\":\"fixture\"}")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let fixture: Value = serde_json::from_slice(&output.stdout).unwrap();
    let manifest = &fixture["manifest"];
    for operation in manifest["operations"].as_array().unwrap() {
        let path = temp.0.join(operation["sourceFile"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path,format!("export function {}(db) {{return db.executeMutation({{databaseRole:{},operationId:{},mutate:(tx)=>tx.run('statement:one')}});}}",operation["entrypoint"].as_str().unwrap(),operation["databaseRole"],operation["operationId"])).unwrap();
    }
    let actual = inspect_online_writer_static_coverage_v1(&temp.0, manifest).unwrap();
    let expected =
        oracle(&[json!({"mode":"inspect","workspaceRoot":temp.0,"manifest":manifest})]).remove(0);
    assert_eq!(actual, expected);
    assert_eq!(actual["blockers"], json!([]));
    let verified = verify_online_writer_static_coverage_v1(&temp.0, manifest).unwrap();
    verified.assert_current().unwrap();
    let undeclared = temp.0.join("paper-adapters/automation/unregistered.mjs");
    std::fs::write(
        &undeclared,
        "export function mutate(db){db.exec('INSERT INTO records VALUES(1)');}",
    )
    .unwrap();
    assert!(verified.assert_current().is_err());
    let actual = inspect_online_writer_static_coverage_v1(&temp.0, manifest).unwrap();
    let expected =
        oracle(&[json!({"mode":"inspect","workspaceRoot":temp.0,"manifest":manifest})]).remove(0);
    assert_eq!(actual, expected);
    assert!(verify_online_writer_static_coverage_v1(&temp.0, manifest).is_err());
    std::fs::remove_file(undeclared).unwrap();
    let path = temp
        .0
        .join(manifest["operations"][0]["sourceFile"].as_str().unwrap());
    let original = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, original.replace("tx.run", "db.run")).unwrap();
    assert!(verified.assert_current().is_err());
    assert!(verify_online_writer_static_coverage_v1(&temp.0, manifest).is_err());
}
