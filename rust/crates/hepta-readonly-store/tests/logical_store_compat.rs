//! Frozen original row/table/store outputs: blob c9b9d7686a4c3ca46011ebd785690f4233ca04ac.
use hepta_codex_protocol::Sha256Digest;
use hepta_readonly_control::{DatabaseFormatV1, DatabaseSchemaV1};
use hepta_readonly_store::{
    LogicalDatabaseSnapshotV1, LogicalSqlValueV1 as Cell, LogicalTableV1,
    logical_store_compat_v1::{self as legacy, ProjectionError},
};
use serde_json::Value;

fn hash(ch: char) -> Sha256Digest {
    format!("sha256:{}", ch.to_string().repeat(64))
        .parse()
        .unwrap()
}
fn fixture() -> LogicalDatabaseSnapshotV1 {
    let row = vec![
        Cell::Integer(i64::MIN),
        Cell::Real("1.25".into()),
        Cell::Text("中文\nquoted\"".into()),
        Cell::BlobHex("00ff".into()),
        Cell::Null,
    ];
    LogicalDatabaseSnapshotV1 {
        version: 1,
        application_id: 1213224753,
        user_version: 25,
        schema: DatabaseSchemaV1 {
            format: DatabaseFormatV1::RustCampaignWriter,
            schema_version: 25,
            user_version: 25,
            application_id: 1213224753,
            local_only: true,
        },
        schema_objects: vec![],
        logical_hash: hash('e'),
        tables: vec![
            LogicalTableV1 {
                name: "mixed".into(),
                columns: ["n", "r", "t", "b", "z"].map(str::to_owned).to_vec(),
                rows: vec![
                    row.clone(),
                    vec![
                        Cell::Integer(i64::MAX),
                        Cell::Real("-2.5".into()),
                        Cell::Text("é".into()),
                        Cell::BlobHex("".into()),
                        Cell::Null,
                    ],
                    row,
                ],
                table_hash: hash('e'),
            },
            LogicalTableV1 {
                name: "SqliteX".into(),
                columns: vec!["a".into()],
                rows: vec![vec![Cell::Integer(1)]],
                table_hash: hash('e'),
            },
            LogicalTableV1 {
                name: "empty".into(),
                columns: vec!["a".into()],
                rows: vec![],
                table_hash: hash('e'),
            },
        ],
    }
}

#[test]
fn original_typed_rows_duplicates_sqlite_like_filter_and_empty_table_match() {
    let expected: Value =
        serde_json::from_str(include_str!("fixtures/logical-store-compat-v1.json")).unwrap();
    let mut snapshot = fixture();
    let actual = legacy::from_logical_snapshot(&snapshot, &hash('d')).unwrap();
    assert_eq!(serde_json::to_value(&actual).unwrap(), expected);
    assert_eq!(actual.tables.len(), 2);
    assert_eq!(actual.tables[1].row_count, 3);
    snapshot.tables.reverse();
    snapshot.tables.last_mut().unwrap().rows.reverse();
    assert_eq!(
        legacy::from_logical_snapshot(&snapshot, &hash('d')).unwrap(),
        actual
    );
}

#[test]
fn database_hash_is_only_a_copied_claim_and_legacy_hashes_are_rebuilt() {
    let mut snapshot = fixture();
    let first = legacy::from_logical_snapshot(&snapshot, &hash('d')).unwrap();
    snapshot.logical_hash = hash('a');
    snapshot.tables[0].table_hash = hash('b');
    let changed_claim = legacy::from_logical_snapshot(&snapshot, &hash('c')).unwrap();
    assert_eq!(first.logical_hash, changed_claim.logical_hash);
    assert_ne!(
        first.database_content_hash,
        changed_claim.database_content_hash
    );
    snapshot.tables[0].rows[0][0] = Cell::Integer(123);
    assert_ne!(
        legacy::from_logical_snapshot(&snapshot, &hash('d'))
            .unwrap()
            .logical_hash,
        first.logical_hash
    );
}

#[test]
fn unsupported_schema_and_non_current_value_spellings_fail_explicitly() {
    let mut snapshot = fixture();
    snapshot.user_version = 0;
    assert!(matches!(
        legacy::from_logical_snapshot(&snapshot, &hash('d')),
        Err(ProjectionError::SchemaProfile)
    ));
    for value in [
        Cell::Real("NaN".into()),
        Cell::Real("inf".into()),
        Cell::Real("1.250".into()),
        Cell::BlobHex("00FF".into()),
        Cell::BlobHex("0".into()),
    ] {
        let mut snapshot = fixture();
        snapshot.tables[0].rows[0][0] = value;
        assert!(matches!(
            legacy::from_logical_snapshot(&snapshot, &hash('d')),
            Err(ProjectionError::ValueProfile)
        ));
    }
    let mut snapshot = fixture();
    snapshot.tables.push(snapshot.tables[0].clone());
    assert!(matches!(
        legacy::from_logical_snapshot(&snapshot, &hash('d')),
        Err(ProjectionError::ValueProfile)
    ));
}
