use super::*;
use rusqlite::Connection;
use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

struct OwnedFixture {
    root: PathBuf,
}
impl OwnedFixture {
    fn new() -> Self {
        let root = PathBuf::from("/dev/shm")
            .join(format!("hepta-raw-node-receipts-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
}
impl Drop for OwnedFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn actual_node_receipt_ledger_matches_original_order_falsy_duplicates_primitives_and_number_coercion()
 {
    let fixture = OwnedFixture::new();
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let selector = workspace.join("paper-domain/evidence/receipt-hash-selector.mjs");
    let composition =
        workspace.join("paper-composition/bootstrap/operator-persistence-composition.mjs");
    let script = format!(
        r#"
import {{DatabaseSync}} from 'node:sqlite';
import {{selectReceiptHash}} from {};
import {{createReadOnlyPaperStore,buildSqliteLogicalIntegrityReport}} from {};
const dbPath=process.argv[1];
const writer=new DatabaseSync(dbPath);
writer.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF');
writer.exec('CREATE TABLE receipt_ledger(receipt_id ANY,receipt_json ANY,receipt_sha256 ANY) STRICT');
const insert=writer.prepare('INSERT INTO receipt_ledger VALUES(?,?,?)');
const corpus=[
 '{{"jobReceiptHash":"job","writeReceiptHash":"write","receiptHash":"explicit"}}',
 '{{"zReceiptHash":"earlier","aReceiptHash":"last"}}',
 '{{"aReceiptHash":"earlier","zReceiptHash":"last"}}',
 '{{"zReceiptHash":"earlier","aReceiptHash":null}}',
 '{{"zReceiptHash":"earlier","aReceiptHash":false}}',
 '{{"zReceiptHash":"earlier","aReceiptHash":0}}',
 '{{"zReceiptHash":"earlier","aReceiptHash":""}}',
 '{{"zReceiptHash":"first","aReceiptHash":"middle","zReceiptHash":"updated"}}',
 '{{"receiptHash":false,"writeReceiptHash":"write","jobReceiptHash":"job"}}',
 '{{"receiptHash":[null,"",true]}}',
 '{{"receiptHash":{{"b":1,"a":2}}}}',
 '{{"receiptHash":1e21}}', '{{"receiptHash":1e-7}}', '{{"receiptHash":1e999}}',
 '{{"kind":true,"value":"payload"}}', '{{"kind":1.5}}', '{{"kind":[null,0]}}',
 '{{"kind":{{"z":1,"a":2}}}}', '{{"kind":false}}', '{{"kind":null}}',
 '[]','[null,1e999,-0,9007199254740993]','true','false','0','-0','1.5','9007199254740993',
 '"primitive"','"\\ud800"','null','{{bad','{{"kind":"Receipt","é":1,"é":2}}',
 '{{"receiptHash":"\\ud800"}}'
];
const expected=[];
for(let i=0;i<corpus.length;i++) {{
 const raw=corpus[i]; let chosen; try {{chosen=selectReceiptHash(JSON.parse(raw));}} catch {{}}
 const valid=i===0 || i===2;
 const actual=valid?chosen:'deliberate-mismatch';
 const id=`case${{String(i).padStart(3,'0')}}:${{valid?chosen:'mismatch'}}`;
 writer.exec('DELETE FROM receipt_ledger'); insert.run(id,raw,actual);
 const store=createReadOnlyPaperStore({{dbPath}});
 let report; try {{report=buildSqliteLogicalIntegrityReport({{dbPath,store}});}} finally {{store.close();}}
 expected.push({{id,invalidJson:report.invalidReceiptRows.length?JSON.stringify(report.invalidReceiptRows[0]):null}});
}}
writer.exec('DELETE FROM receipt_ledger');
for(let i=0;i<corpus.length;i++) {{
 const raw=corpus[i];let chosen;try{{chosen=selectReceiptHash(JSON.parse(raw));}}catch{{}}
 const valid=i===0 || i===2; insert.run(expected[i].id,raw,valid?chosen:'deliberate-mismatch');
}}
writer.close();
console.log(JSON.stringify({{profile:{{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr,locale:new Intl.Collator().resolvedOptions().locale}},expected}}));
"#,
        serde_json::json!(format!("file://{}", selector.display())),
        serde_json::json!(format!("file://{}", composition.display()))
    );
    let path = fixture.root.join("ordinary.sqlite");
    let output = Command::new(
        std::env::var_os("HEPTA_TEST_NODE")
            .or_else(|| std::env::var_os("HEPTA_NODE_BINARY"))
            .unwrap_or_else(|| "node".into()),
    )
    .args(["--input-type=module", "--eval", &script])
    .arg(&path)
    .env_clear()
    .env("PATH", "/usr/bin:/bin")
    .env("LANG", "en_US.UTF-8")
    .env("LC_ALL", "en_US.UTF-8")
    .env_remove("NODE_OPTIONS")
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(oracle["profile"]["node"], "v22.23.1");
    assert_eq!(oracle["profile"]["icu"], "78.2");
    assert_eq!(oracle["profile"]["cldr"], "48.0");
    assert_eq!(oracle["profile"]["locale"], "en-US");
    let before = fs::read(&path).unwrap();
    let ordinary = crate::OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    let report = ordinary.node_logical_integrity_report().unwrap();
    assert_eq!(
        report.receipt_ledger_row_count,
        oracle["expected"].as_array().unwrap().len() as u64
    );
    let expected_invalid = oracle["expected"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["invalidJson"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        report.invalid_receipt_hash_count,
        expected_invalid.len() as u64
    );
    for (actual, expected) in report.invalid_receipt_rows.iter().zip(&expected_invalid) {
        assert_eq!(
            parse_and_encode_production_v1(actual.get().as_bytes()).unwrap(),
            parse_and_encode_production_v1(expected.as_bytes()).unwrap()
        );
    }
    ordinary.verify_unchanged().unwrap();
    let connection =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT receipt_id,receipt_json,receipt_sha256 FROM receipt_ledger ORDER BY receipt_id",
        )
        .unwrap();
    let mut rows = statement.query([]).unwrap();
    for expected in oracle["expected"].as_array().unwrap() {
        let row = rows.next().unwrap().unwrap();
        let id = NodeValue::from_sql(row.get_ref(0).unwrap(), false).unwrap();
        assert_eq!(id.string(), expected["id"]);
        let input = NodeValue::from_sql(row.get_ref(1).unwrap(), false).unwrap();
        let actual = NodeValue::from_sql(row.get_ref(2).unwrap(), false).unwrap();
        let invalid = inspect_row(&id, &input, &actual).unwrap();
        match expected["invalidJson"].as_str() {
            None => assert!(invalid.is_none(), "{}", id.string()),
            Some(text) => assert_eq!(
                parse_and_encode_production_v1(invalid.unwrap().get().as_bytes()).unwrap(),
                parse_and_encode_production_v1(text.as_bytes()).unwrap(),
                "{}",
                id.string()
            ),
        }
    }
    assert!(rows.next().unwrap().is_none());
    assert_eq!(before, fs::read(&path).unwrap());
}
