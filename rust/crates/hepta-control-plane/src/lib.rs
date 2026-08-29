//! One-paper local author/workspace/prepared-result vertical slice.

use std::{fs, path::{Path, PathBuf}};

use hepta_campaign_writer::{
    CampaignWriterError, CampaignWriterStoreV1, FaultPointV1 as WriterFaultPointV1, NodeStatusV1,
    PreparedNodeResultV1, WriterAuthorityV1,
};
use hepta_legacy_compat::{encode_legacy_stable_json_v1, hash_legacy_stable_json_v1};
use hepta_workspace::{
    MutationPolicyV1, PreparedWorkspaceResultV1, WorkspaceError, WorkspaceRoot,
    materialize_attempt,
};
use serde_json::json;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalSliceFaultV1 {
    None,
    AfterClaim,
    AfterWorkspaceMutation,
    AfterPreparedJournal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalSlicePlanV1 {
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub claim_owner: String,
    pub plan_hash: String,
}

impl LocalSlicePlanV1 {
    pub fn new(
        campaign_id: impl Into<String>,
        node_id: impl Into<String>,
        attempt_id: impl Into<String>,
        claim_owner: impl Into<String>,
    ) -> Result<Self, LocalSliceError> {
        let campaign_id = campaign_id.into();
        let node_id = node_id.into();
        let attempt_id = attempt_id.into();
        let claim_owner = claim_owner.into();
        let value = json!({
            "attemptId": attempt_id,
            "campaignId": campaign_id,
            "claimOwner": claim_owner,
            "nodeId": node_id,
            "version": 1,
        });
        let _canonical = encode_legacy_stable_json_v1(&value)?;
        let plan_hash = hash_legacy_stable_json_v1(&value)?.as_str().to_owned();
        Ok(Self {
            campaign_id,
            node_id,
            attempt_id,
            claim_owner,
            plan_hash,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalSliceResultV1 {
    pub plan: LocalSlicePlanV1,
    pub prepared_workspace: PreparedWorkspaceResultV1,
    pub prepared_journal: PreparedNodeResultV1,
    pub integrated_node: NodeStatusV1,
}

#[allow(clippy::too_many_arguments)]
pub fn run_local_author_slice(
    store: &mut CampaignWriterStoreV1,
    authority: &WriterAuthorityV1,
    source_root: &WorkspaceRoot,
    attempt_root: impl AsRef<Path>,
    plan: LocalSlicePlanV1,
    authored_bytes: &[u8],
    now_unix_ms: u64,
    fault: LocalSliceFaultV1,
) -> Result<LocalSliceResultV1, LocalSliceError> {
    store.create_campaign(authority, &plan.campaign_id, 1_000_000, 8, now_unix_ms)?;
    store.add_node(
        authority,
        &plan.campaign_id,
        &plan.node_id,
        now_unix_ms.saturating_add(1),
    )?;
    let revision = store.campaign_status(&plan.campaign_id)?.revision;
    let claim = store.claim_node(
        authority,
        &plan.campaign_id,
        &plan.node_id,
        revision,
        &plan.attempt_id,
        &plan.claim_owner,
        now_unix_ms.saturating_add(60_000),
        100_000,
        1,
        now_unix_ms.saturating_add(2),
        WriterFaultPointV1::None,
    )?;
    if fault == LocalSliceFaultV1::AfterClaim {
        return Err(LocalSliceError::InjectedFault(fault));
    }

    let attempt = materialize_attempt(source_root, attempt_root.as_ref())?;
    attempt
        .root()
        .write_file("paper/main.tex", authored_bytes)?;
    if fault == LocalSliceFaultV1::AfterWorkspaceMutation {
        return Err(LocalSliceError::InjectedFault(fault));
    }
    let prepared_workspace = attempt.prepare(&MutationPolicyV1::author())?;
    let prepared_journal = store.record_prepared_result(
        authority,
        &claim,
        prepared_workspace.prepared_result_hash.as_str(),
        false,
        now_unix_ms.saturating_add(3),
        WriterFaultPointV1::None,
    )?;
    if fault == LocalSliceFaultV1::AfterPreparedJournal {
        return Err(LocalSliceError::InjectedFault(fault));
    }
    let integrated_node = store.integrate_prepared_result(
        authority,
        &prepared_journal,
        prepared_workspace.result_inventory_hash.as_str(),
        now_unix_ms.saturating_add(4),
        WriterFaultPointV1::None,
    )?;
    Ok(LocalSliceResultV1 {
        plan,
        prepared_workspace,
        prepared_journal,
        integrated_node,
    })
}

pub fn resume_prepared_without_provider_reexecution(
    store: &mut CampaignWriterStoreV1,
    authority: &WriterAuthorityV1,
    campaign_id: &str,
    node_id: &str,
    integrated_result_hash: &str,
    now_unix_ms: u64,
) -> Result<NodeStatusV1, LocalSliceError> {
    let prepared = store.load_prepared_result(campaign_id, node_id)?;
    Ok(store.integrate_prepared_result(
        authority,
        &prepared,
        integrated_result_hash,
        now_unix_ms,
        WriterFaultPointV1::None,
    )?)
}

#[derive(Debug, Error)]
pub enum LocalSliceError {
    #[error("local slice fault injected at {0:?}")]
    InjectedFault(LocalSliceFaultV1),
    #[error(transparent)]
    Writer(#[from] CampaignWriterError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Compatibility(#[from] hepta_legacy_compat::LegacyCompatError),
    #[error("local slice filesystem operation failed: {0:?}")]
    Filesystem(std::io::ErrorKind),
}

#[cfg(test)]
mod tests {
    use super::*;
    use hepta_campaign_writer::NodeStateV1;
    use std::{
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        database: PathBuf,
        uid: u32,
    }

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "hepta-local-slice-{}-{nonce}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).expect("root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
            let source = root.join("source");
            fs::create_dir(&source).expect("source");
            fs::create_dir(source.join("paper")).expect("paper");
            fs::write(source.join("paper/main.tex"), b"initial").expect("initial source");
            let uid = fs::metadata(&root).expect("metadata").uid();
            Self {
                database: root.join("campaign.sqlite"),
                root,
                source,
                uid,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn local_slice_integrates_without_mutating_source() {
        let fixture = Fixture::new();
        let mut store = CampaignWriterStoreV1::open(&fixture.database, fixture.uid).expect("store");
        let authority = WriterAuthorityV1::new(1, "writer-token-1").expect("authority");
        store.acquire_writer(&authority, 1).expect("acquire");
        let source = WorkspaceRoot::open(&fixture.source).expect("source");
        let plan = LocalSlicePlanV1::new("campaign-1", "node-1", "attempt-1", "worker-1")
            .expect("plan");
        let result = run_local_author_slice(
            &mut store,
            &authority,
            &source,
            fixture.root.join("attempt"),
            plan,
            b"authored",
            10,
            LocalSliceFaultV1::None,
        )
        .expect("slice");
        assert_eq!(result.integrated_node.state, NodeStateV1::Completed);
        assert_eq!(fs::read(fixture.source.join("paper/main.tex")).expect("source"), b"initial");
    }

    #[test]
    fn prepared_crash_resumes_without_rerunning_author() {
        let fixture = Fixture::new();
        let mut store = CampaignWriterStoreV1::open(&fixture.database, fixture.uid).expect("store");
        let authority = WriterAuthorityV1::new(1, "writer-token-1").expect("authority");
        store.acquire_writer(&authority, 1).expect("acquire");
        let source = WorkspaceRoot::open(&fixture.source).expect("source");
        let plan = LocalSlicePlanV1::new("campaign-1", "node-1", "attempt-1", "worker-1")
            .expect("plan");
        assert!(matches!(
            run_local_author_slice(
                &mut store,
                &authority,
                &source,
                fixture.root.join("attempt"),
                plan,
                b"authored",
                10,
                LocalSliceFaultV1::AfterPreparedJournal,
            ),
            Err(LocalSliceError::InjectedFault(LocalSliceFaultV1::AfterPreparedJournal))
        ));
        let result_hash = store
            .load_prepared_result("campaign-1", "node-1")
            .expect("prepared")
            .prepared_receipt_hash;
        drop(store);
        let mut reopened = CampaignWriterStoreV1::open(&fixture.database, fixture.uid).expect("reopen");
        reopened.acquire_writer(&authority, 20).expect("reacquire");
        let result = resume_prepared_without_provider_reexecution(
            &mut reopened,
            &authority,
            "campaign-1",
            "node-1",
            &result_hash,
            21,
        )
        .expect("resume");
        assert_eq!(result.state, NodeStateV1::Completed);
    }
}
