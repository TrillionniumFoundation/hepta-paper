//! Admission for a local offline execution on the incumbent schema-25 store.
//!
//! Production admission remains unavailable until the native-store activation
//! contract binds the signed subject to this exact writer epoch and scope.
//! This entrypoint consumes an already-established local cutover epoch. It
//! never enrolls a database, advances ownership, or accepts JSON trust claims.

use super::offline_execution::ReconciliationClockV1;
use super::{
    AutomationRuntimeReconciliationError as Error, legacy_terminal_residue, offline_execution,
};
use crate::node_package_deletion_writer::PackageDeletionWriterGuard;
use hepta_cutover::{
    DurableCutoverCoordinatorV1, DurableCutoverModeV1, DurableCutoverPhaseV1, WriterFenceV1,
};
use hepta_readonly_control::node_schema::NODE_MIGRATIONS_V1;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub const LOCAL_RECONCILIATION_WRITER_ID_V1: &str = "automation-runtime-reconciler-rust";
pub const RECONCILIATION_WRITER_SCOPE_V1: &str = "store:automation-reconcile-entrypoint";

/// Select the incumbent business policy before any plan or writable admission.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalReconciliationOperationV1 {
    #[default]
    Standard,
    LegacyTerminalActiveResidue,
}

/// Explicit deployment roots and a durable epoch, not a writable store handle.
/// All four roots must already exist and be canonical, separate directories.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalOfflineReconciliationRequestV1 {
    pub version: u16,
    #[serde(default)]
    pub operation: LocalReconciliationOperationV1,
    pub workspace_root: PathBuf,
    pub asset_root: PathBuf,
    pub runtime_root: PathBuf,
    pub legacy_root: PathBuf,
    pub writer_fence: WriterFenceV1,
    /// A fixed test/repair instant; omission uses the live system clock.
    pub now: Option<String>,
    pub no_progress_seconds: f64,
    pub campaign_id: Option<String>,
    pub release_commit: Option<String>,
}

fn rejected(code: &str) -> Error {
    Error::Admission(code.to_owned())
}

struct RetainedIdentity {
    path: PathBuf,
    file: File,
    directory: bool,
}

impl RetainedIdentity {
    fn open(path: &Path, directory: bool) -> Result<Self, Error> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
            || fs::canonicalize(path).map_err(|_| rejected("reconciliation_path_invalid"))? != path
        {
            return Err(rejected("reconciliation_path_invalid"));
        }
        let before =
            fs::symlink_metadata(path).map_err(|_| rejected("reconciliation_path_invalid"))?;
        if before.file_type().is_symlink()
            || (directory && !before.is_dir())
            || (!directory && !before.is_file())
        {
            return Err(rejected("reconciliation_path_invalid"));
        }
        let flags = nix::libc::O_NOFOLLOW
            | nix::libc::O_NONBLOCK
            | nix::libc::O_CLOEXEC
            | if directory { nix::libc::O_DIRECTORY } else { 0 };
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
            .map_err(|_| rejected("reconciliation_path_invalid"))?;
        let identity = Self {
            path: path.to_owned(),
            file,
            directory,
        };
        identity.assert_current()?;
        let opened = identity
            .file
            .metadata()
            .map_err(|_| rejected("reconciliation_path_identity_changed"))?;
        if opened.dev() != before.dev() || opened.ino() != before.ino() {
            return Err(rejected("reconciliation_path_identity_changed"));
        }
        Ok(identity)
    }

    fn assert_current(&self) -> Result<(), Error> {
        let path = fs::symlink_metadata(&self.path)
            .map_err(|_| rejected("reconciliation_path_identity_changed"))?;
        let held = self
            .file
            .metadata()
            .map_err(|_| rejected("reconciliation_path_identity_changed"))?;
        if path.file_type().is_symlink()
            || path.dev() != held.dev()
            || path.ino() != held.ino()
            || path.uid() != nix::unistd::geteuid().as_raw()
            || (self.directory && (!path.is_dir() || path.mode() & 0o022 != 0))
            || (!self.directory
                && (!path.is_file() || path.nlink() != 1 || path.mode() & 0o077 != 0))
            || fs::canonicalize(&self.path)
                .map_err(|_| rejected("reconciliation_path_identity_changed"))?
                != self.path
        {
            return Err(rejected("reconciliation_path_identity_changed"));
        }
        Ok(())
    }
}

fn roots(request: &LocalOfflineReconciliationRequestV1) -> Result<Vec<RetainedIdentity>, Error> {
    let paths = [
        &request.workspace_root,
        &request.asset_root,
        &request.runtime_root,
        &request.legacy_root,
    ];
    for (i, left) in paths.iter().enumerate() {
        for right in &paths[i + 1..] {
            if left.starts_with(right) || right.starts_with(left) {
                return Err(rejected("workspace_layout_not_physically_decoupled"));
            }
        }
    }
    paths
        .into_iter()
        .map(|p| RetainedIdentity::open(p, true))
        .collect()
}

fn schema(connection: &Connection) -> Result<(), Error> {
    let online: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE lower(name) GLOB 'autonomous_research_online_mutation_*' OR lower(tbl_name) GLOB 'autonomous_research_online_mutation_*' OR lower(name) GLOB 'autonomous_research_online_authority_*' OR lower(tbl_name) GLOB 'autonomous_research_online_authority_*')",
        [], |row| row.get(0),
    )?;
    if online {
        return Err(rejected(
            "reconciliation_online_mutation_authority_required",
        ));
    }
    let mut query = connection.prepare("SELECT version,name,migration_sha256 FROM schema_migrations WHERE version IN (21,22,23,24,25) ORDER BY version")?;
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let expected = NODE_MIGRATIONS_V1
        .iter()
        .filter(|m| m.version >= 21)
        .collect::<Vec<_>>();
    if rows.len() != expected.len()
        || rows
            .iter()
            .zip(expected)
            .any(|((version, name, hash), expected)| {
                *version != expected.version
                    || name != expected.name
                    || *hash
                        != format!(
                            "sha256:{}",
                            hex::encode(Sha256::digest(expected.sql.as_bytes()))
                        )
            })
    {
        return Err(rejected("scoped_schema_version_gate_failed"));
    }
    Ok(())
}

/// Execute the complete offline business transaction under existing local
/// ownership, the Node-compatible package fence and exact schema admission.
/// The returned envelope explicitly cannot qualify production or Node retirement.
pub fn execute_local_offline_automation_runtime_reconciliation_v1(
    request: &LocalOfflineReconciliationRequestV1,
) -> Result<Value, Error> {
    if request.version != 1
        || request.writer_fence.writer_id != LOCAL_RECONCILIATION_WRITER_ID_V1
        || !request.no_progress_seconds.is_finite()
    {
        return Err(rejected("reconciliation_local_writer_request_invalid"));
    }
    let roots = roots(request)?;
    let database = request.runtime_root.join("hepta-paper.sqlite");
    let retained_database = RetainedIdentity::open(&database, false)?;
    {
        let reader = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        schema(&reader)?;
        match request.operation {
            LocalReconciliationOperationV1::Standard => {
                if let Some(now) = &request.now {
                    super::plan_on_connection(
                        &reader,
                        now,
                        request.no_progress_seconds,
                        request.campaign_id.as_deref(),
                    )?;
                } else {
                    super::verify_campaign_scope(&reader, request.campaign_id.as_deref())?;
                }
            }
            LocalReconciliationOperationV1::LegacyTerminalActiveResidue => {
                let campaign = request.campaign_id.as_deref().ok_or_else(|| {
                    rejected("legacy_terminal_active_residue_campaign_id_required")
                })?;
                // The selected planner validates v0 policy and coordination rows;
                // never run the standard v1 campaign gate for legacy maintenance.
                if let Some(now) = &request.now {
                    legacy_terminal_residue::plan_on_connection(&reader, now, campaign)?;
                } else {
                    legacy_terminal_residue::verify_campaign_scope(&reader, campaign)?;
                }
            }
        }
    }
    let mut coordinator = DurableCutoverCoordinatorV1::open(&database)
        .map_err(|e| rejected(&format!("reconciliation_cutover_required:{e}")))?;
    let state = coordinator
        .inspect()
        .map_err(|e| rejected(&e.to_string()))?;
    if state.mode != DurableCutoverModeV1::LocalDrill
        || state.production_activation
        || state.activation_receipt_hash.is_some()
        || !matches!(
            state.phase,
            DurableCutoverPhaseV1::Canary | DurableCutoverPhaseV1::Active
        )
        || state.new_writer_id != LOCAL_RECONCILIATION_WRITER_ID_V1
        || state.writer_fence().as_ref() != Some(&request.writer_fence)
    {
        return Err(rejected("reconciliation_local_cutover_writer_required"));
    }
    // Lock order matches the Node foundation: package fence, then cutover fence,
    // then the application database. No raw connection escapes this scope.
    let package =
        PackageDeletionWriterGuard::acquire(&request.runtime_root, RECONCILIATION_WRITER_SCOPE_V1)
            .map_err(|e| rejected(&e.to_string()))?;
    let receipt = coordinator
        .with_writer(
            &request.writer_fence,
            RECONCILIATION_WRITER_SCOPE_V1,
            || {
                let operation = || -> Result<Value, Error> {
                    let current = || -> Result<(), Error> {
                        for root in &roots {
                            root.assert_current()?;
                        }
                        retained_database.assert_current()?;
                        package
                            .assert_current()
                            .map_err(|e| rejected(&e.to_string()))
                    };
                    current()?;
                    let mut connection = Connection::open_with_flags(
                        &database,
                        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
                    )?;
                    connection.busy_timeout(Duration::from_secs(10))?;
                    connection
                        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")?;
                    schema(&connection)?;
                    current()?;
                    let before_apply = |connection: &Connection| {
                        current()?;
                        schema(connection)
                    };
                    if matches!(
                        request.operation,
                        LocalReconciliationOperationV1::LegacyTerminalActiveResidue
                    ) {
                        let campaign = request.campaign_id.as_deref().ok_or_else(|| {
                            rejected("legacy_terminal_active_residue_campaign_id_required")
                        })?;
                        let mut clock = offline_execution::SystemReconciliationClockV1;
                        let mut now_iso = || match &request.now {
                            Some(now) => Ok(now.clone()),
                            None => clock.now_iso(),
                        };
                        return legacy_terminal_residue::execute_on_admitted_connection(
                            &mut connection,
                            campaign,
                            request.release_commit.as_deref(),
                            &mut now_iso,
                            before_apply,
                            current,
                        );
                    }
                    match request.now.as_deref() {
                        Some(now) => offline_execution::execute_on_admitted_connection(
                            &mut connection,
                            now,
                            request.no_progress_seconds,
                            request.campaign_id.as_deref(),
                            request.release_commit.as_deref(),
                            before_apply,
                            current,
                        ),
                        None => offline_execution::execute_on_admitted_connection_with_clock(
                            &mut connection,
                            &mut offline_execution::SystemReconciliationClockV1,
                            request.no_progress_seconds,
                            request.campaign_id.as_deref(),
                            request.release_commit.as_deref(),
                            before_apply,
                            current,
                        ),
                    }
                };
                operation().map_err(|e| e.to_string())
            },
        )
        .map_err(|e| rejected(&e.to_string()))?;
    // Match the incumbent scope's final identity check. At this stage business
    // data is committed, so make an uncertain post-commit outcome distinguishable
    // from the transaction's rolled-back precondition failures.
    let after_commit = || -> Result<(), Error> {
        for root in &roots {
            root.assert_current()?;
        }
        retained_database.assert_current()?;
        package
            .assert_current()
            .map_err(|e| rejected(&e.to_string()))
    };
    after_commit().map_err(|e| {
        rejected(&format!(
            "reconciliation_committed_scope_verification_failed:{e}"
        ))
    })?;
    Ok(json!({
        "version":1,"kind":"LocalOfflineAutomationRuntimeReconciliationExecution",
        "status":"local_offline_automation_runtime_reconciled",
        "cutoverId":state.cutover_id,"writerFence":request.writer_fence,"operation":request.operation,
        "reconciliation":receipt,"productionActivation":false,"nodeRetirementVerified":false
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    const NOW: &str = "2026-07-13T08:00:00.000Z";
    struct Fixture {
        root: PathBuf,
        request: LocalOfflineReconciliationRequestV1,
    }
    impl Fixture {
        fn new(enroll: bool, scope: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "hepta-reconciliation-admission-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            for name in ["workspace", "assets", "runtime", "legacy"] {
                let p = root.join(name);
                fs::create_dir(&p).unwrap();
                fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
            }
            let db = root.join("runtime/hepta-paper.sqlite");
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let output = Command::new("node")
                .current_dir(repo)
                .args([
                    "rust/oracle/automation-runtime-reconciliation-v1.mjs",
                    "--database",
                    db.to_str().unwrap(),
                    "--at",
                    NOW,
                    "--prepare",
                ])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
            let node: Value = serde_json::from_slice(&output.stdout).unwrap();
            let rust =
                super::super::inspect_automation_runtime_reconciliation_v1(&db, NOW, 1800.0, None)
                    .unwrap();
            assert_eq!(node, rust);
            let fence = if enroll {
                let mut c = DurableCutoverCoordinatorV1::create(
                    &db,
                    "offline-reconciliation-test",
                    "node",
                    LOCAL_RECONCILIATION_WRITER_ID_V1,
                    DurableCutoverModeV1::LocalDrill,
                )
                .unwrap();
                c.quiesce(0).unwrap();
                c.backup_restore_drill(
                    1,
                    &root.join("backup.sqlite"),
                    &root.join("restore.sqlite"),
                )
                .unwrap();
                c.compare_shadow(
                    2,
                    "reconciliation-plan",
                    &serde_json::to_vec(&node).unwrap(),
                    &serde_json::to_vec(&rust).unwrap(),
                )
                .unwrap();
                c.start_local_canary(3, vec![scope.to_owned()])
                    .unwrap()
                    .writer_fence()
                    .unwrap()
            } else {
                WriterFenceV1 {
                    writer_id: LOCAL_RECONCILIATION_WRITER_ID_V1.into(),
                    generation: 3,
                    token: "missing:3".into(),
                }
            };
            let request = LocalOfflineReconciliationRequestV1 {
                version: 1,
                operation: LocalReconciliationOperationV1::Standard,
                workspace_root: root.join("workspace"),
                asset_root: root.join("assets"),
                runtime_root: root.join("runtime"),
                legacy_root: root.join("legacy"),
                writer_fence: fence,
                now: Some(NOW.into()),
                no_progress_seconds: 1800.0,
                campaign_id: None,
                release_commit: None,
            };
            Self { root, request }
        }
        fn db(&self) -> PathBuf {
            self.request.runtime_root.join("hepta-paper.sqlite")
        }
        fn rejected_without_database_change(&self, expected: &str) {
            let before = fs::read(self.db()).unwrap();
            let error = execute_local_offline_automation_runtime_reconciliation_v1(&self.request)
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{error}");
            assert_eq!(fs::read(self.db()).unwrap(), before);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn admitted_schema25_transaction_commits_and_node_ownership_is_fenced() {
        let f = Fixture::new(true, RECONCILIATION_WRITER_SCOPE_V1);
        let result =
            execute_local_offline_automation_runtime_reconciliation_v1(&f.request).unwrap();
        assert_eq!(result["productionActivation"], false);
        assert_eq!(result["nodeRetirementVerified"], false);
        assert_eq!(
            result["reconciliation"]["status"],
            "automation_runtime_reconciled"
        );
        assert_eq!(result["reconciliation"]["recoveredNodeCount"], 1);
        let db = Connection::open(f.db()).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM receipt_ledger WHERE stream='automation-reconciliation' AND writer_trusted=1 AND evidence_class='runtime_reconciliation'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        drop(db);
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let node=Command::new("node").current_dir(repo).args(["--input-type=module","-e","import {createSqliteStore} from './paper-adapters/persistence/sqlite-store.mjs'; try { createSqliteStore({dbPath:process.argv[1]}); process.exit(9); } catch(e) { if(!e.message.includes('node_writer_disabled')) throw e; }",f.db().to_str().unwrap()]).output().unwrap();
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
    }

    #[test]
    fn enrollment_epoch_scope_and_rollback_are_required() {
        Fixture::new(false, RECONCILIATION_WRITER_SCOPE_V1)
            .rejected_without_database_change("reconciliation_cutover_required");
        Fixture::new(true, "unrelated-scope").rejected_without_database_change("scope");
        let mut f = Fixture::new(true, RECONCILIATION_WRITER_SCOPE_V1);
        f.request.writer_fence.generation += 1;
        f.rejected_without_database_change("local_cutover_writer_required");
        f.request.writer_fence.generation -= 1;
        let mut coordinator = DurableCutoverCoordinatorV1::open(f.db()).unwrap();
        coordinator.rollback_local(4).unwrap();
        drop(coordinator);
        f.rejected_without_database_change("local_cutover_writer_required");
    }

    #[test]
    fn schema_history_and_online_authority_objects_block_before_mutation() {
        for sql in [
            "DELETE FROM schema_migrations WHERE version=25",
            "UPDATE schema_migrations SET migration_sha256='sha256:wrong' WHERE version=21",
            "CREATE TABLE autonomous_research_online_mutation_authority_metadata (singleton INTEGER)",
            "CREATE TABLE AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_MARKER (singleton INTEGER)",
            "CREATE VIEW autonomous_research_online_mutation_finalization_receipt AS SELECT 1",
            "CREATE TRIGGER autonomous_research_online_mutation_leftover AFTER UPDATE ON campaign_nodes BEGIN SELECT 1; END",
            "CREATE TABLE autonomous_research_online_authority_metadata (singleton INTEGER)",
        ] {
            let f = Fixture::new(true, RECONCILIATION_WRITER_SCOPE_V1);
            let c = Connection::open(f.db()).unwrap();
            c.execute_batch(sql).unwrap();
            drop(c);
            f.rejected_without_database_change(if sql.contains("schema_migrations") {
                "scoped_schema_version_gate_failed"
            } else {
                "online_mutation_authority_required"
            });
        }
    }

    #[test]
    fn canonical_separate_roots_and_single_link_database_are_required() {
        let mut f = Fixture::new(true, RECONCILIATION_WRITER_SCOPE_V1);
        f.request.asset_root = f.request.workspace_root.clone();
        f.rejected_without_database_change("not_physically_decoupled");
        f.request.asset_root = f.root.join("assets");
        fs::hard_link(f.db(), f.root.join("database-alias")).unwrap();
        f.rejected_without_database_change("path_identity_changed");
        fs::remove_file(f.root.join("database-alias")).unwrap();
        let alias = f.root.join("runtime-alias");
        std::os::unix::fs::symlink(&f.request.runtime_root, &alias).unwrap();
        f.request.runtime_root = alias;
        f.rejected_without_database_change("path_invalid");
    }

    #[test]
    fn nonregular_database_and_production_enrollment_are_rejected() {
        let f = Fixture::new(false, RECONCILIATION_WRITER_SCOPE_V1);
        let coordinator = DurableCutoverCoordinatorV1::create(
            f.db(),
            "production-cannot-use-local-entry",
            "node",
            LOCAL_RECONCILIATION_WRITER_ID_V1,
            DurableCutoverModeV1::Production,
        )
        .unwrap();
        drop(coordinator);
        f.rejected_without_database_change("local_cutover_writer_required");
        fs::remove_file(f.db()).unwrap();
        nix::unistd::mkfifo(
            &f.db(),
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();
        assert!(RetainedIdentity::open(&f.db(), false).is_err());
    }

    #[test]
    fn omitted_business_time_uses_live_clock_inside_admitted_scope() {
        let mut f = Fixture::new(true, RECONCILIATION_WRITER_SCOPE_V1);
        f.request.now = None;
        let millis = || {
            i64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap()
        };
        let before = millis();
        let result =
            execute_local_offline_automation_runtime_reconciliation_v1(&f.request).unwrap();
        let after = millis();
        for instant in [
            &result["reconciliation"]["reconciledAt"],
            &result["reconciliation"]["ledgerReceipt"]["createdAt"],
            &result["reconciliation"]["after"]["plannedAt"],
        ] {
            let observed =
                crate::journal_connector_coverage::qualification::canonical_instant_millis(
                    instant.as_str().unwrap(),
                )
                .unwrap();
            assert!((before..=after).contains(&observed));
        }
        assert_eq!(result["productionActivation"], false);
    }

    #[test]
    fn legacy_selector_uses_v0_preflight_and_keeps_parent_and_other_campaigns() {
        let mut f = Fixture::new(true, RECONCILIATION_WRITER_SCOPE_V1);
        f.request.campaign_id = Some("campaign-6".into());
        f.rejected_without_database_change("input is invalid");
        f.request.operation = LocalReconciliationOperationV1::LegacyTerminalActiveResidue;
        f.request.campaign_id = Some("campaign-3".into());
        f.rejected_without_database_change("policy_not_v0");
        f.request.campaign_id = Some("campaign-6".into());
        let db = Connection::open(f.db()).unwrap();
        let parents = super::super::rows(
            &db,
            "SELECT * FROM paper_campaigns ORDER BY campaign_id",
            [],
        )
        .unwrap();
        let other_nodes = super::super::rows(
            &db,
            "SELECT * FROM campaign_nodes WHERE campaign_id!='campaign-6' ORDER BY node_id",
            [],
        )
        .unwrap();
        drop(db);
        let result =
            execute_local_offline_automation_runtime_reconciliation_v1(&f.request).unwrap();
        assert_eq!(result["operation"], "legacy_terminal_active_residue");
        assert_eq!(
            result["reconciliation"]["status"],
            "legacy_terminal_active_residue_settled"
        );
        assert_eq!(
            result["reconciliation"]["settledNodeIds"],
            json!(["node-6"])
        );
        assert_eq!(result["reconciliation"]["after"]["nodes"], json!([]));
        let db = Connection::open(f.db()).unwrap();
        assert_eq!(
            super::super::rows(
                &db,
                "SELECT * FROM paper_campaigns ORDER BY campaign_id",
                []
            )
            .unwrap(),
            parents
        );
        assert_eq!(
            super::super::rows(
                &db,
                "SELECT * FROM campaign_nodes WHERE campaign_id!='campaign-6' ORDER BY node_id",
                []
            )
            .unwrap(),
            other_nodes
        );
    }
}
