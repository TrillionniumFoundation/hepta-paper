use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{
    CapabilityAuthorityOwnerV1, CapabilityMigrationLedgerV1, CapabilityMigrationRecordV1,
    CapabilityMigrationStageV1, CapabilityRecoveryModeV1, LegacyParityClassV1,
};

fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .expect("digest")
}

fn initial() -> CapabilityMigrationRecordV1 {
    CapabilityMigrationRecordV1 {
        version: 1,
        capability_id: "CAP-AUTHOR".to_owned(),
        node_module_id: "module.node-control-plane".to_owned(),
        rust_module_id: "module.author-node".to_owned(),
        node_contract_hash: digest('a'),
        rust_contract_hash: digest('b'),
        parity_class: LegacyParityClassV1::Semantic,
        requires_external_authority: false,
        stage: CapabilityMigrationStageV1::NodeAuthoritative,
        authoritative_owner: CapabilityAuthorityOwnerV1::Node,
        recovery_mode: CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority,
        node_execution_enabled: true,
        rust_execution_enabled: false,
        translation_receipt_hash: None,
        shadow_receipt_hash: None,
        canary_receipt_hash: None,
        rollback_receipt_hash: None,
        legacy_freeze_receipt_hash: None,
        authority_transfer_receipt_hash: None,
        first_rust_commit_receipt_hash: None,
        external_authority_receipt_hash: None,
        node_retirement_receipt_hash: None,
    }
}

fn shadow(initial: &CapabilityMigrationRecordV1) -> CapabilityMigrationRecordV1 {
    let mut next = initial.clone();
    next.stage = CapabilityMigrationStageV1::RustShadow;
    next.rust_execution_enabled = true;
    next.translation_receipt_hash = Some(digest('c'));
    next.shadow_receipt_hash = Some(digest('d'));
    next
}

fn canary(shadow: &CapabilityMigrationRecordV1) -> CapabilityMigrationRecordV1 {
    let mut next = shadow.clone();
    next.stage = CapabilityMigrationStageV1::RustCanary;
    next.canary_receipt_hash = Some(digest('e'));
    next.rollback_receipt_hash = Some(digest('f'));
    next
}

#[test]
fn canary_preserves_node_rollback_only_before_rust_authority() {
    let mut ledger = CapabilityMigrationLedgerV1::default();
    let initial = initial();
    ledger.insert_initial(initial.clone()).expect("initial");
    let shadow = shadow(&initial);
    ledger.advance(shadow.clone()).expect("shadow");
    let canary = canary(&shadow);
    ledger.advance(canary.clone()).expect("canary");

    assert_eq!(canary.authoritative_owner, CapabilityAuthorityOwnerV1::Node);
    assert_eq!(
        canary.recovery_mode,
        CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority
    );
    assert!(canary.node_execution_enabled);
    assert!(canary.rust_execution_enabled);
    assert!(canary.legacy_freeze_receipt_hash.is_none());
    assert!(canary.first_rust_commit_receipt_hash.is_none());
}

#[test]
fn first_authoritative_rust_commit_forces_forward_only_recovery() {
    let mut ledger = CapabilityMigrationLedgerV1::default();
    let initial = initial();
    ledger.insert_initial(initial.clone()).expect("initial");
    let shadow = shadow(&initial);
    ledger.advance(shadow.clone()).expect("shadow");
    let canary = canary(&shadow);
    ledger.advance(canary.clone()).expect("canary");

    let mut authoritative = canary;
    authoritative.stage = CapabilityMigrationStageV1::RustAuthoritative;
    authoritative.authoritative_owner = CapabilityAuthorityOwnerV1::Rust;
    authoritative.recovery_mode = CapabilityRecoveryModeV1::ForwardOnlyAfterRustAuthority;
    authoritative.node_execution_enabled = false;
    authoritative.legacy_freeze_receipt_hash = Some(digest('0'));
    authoritative.authority_transfer_receipt_hash = Some(digest('1'));
    authoritative.first_rust_commit_receipt_hash = Some(digest('2'));
    ledger
        .advance(authoritative.clone())
        .expect("authoritative Rust");

    let mut retired = authoritative.clone();
    retired.stage = CapabilityMigrationStageV1::NodeRetired;
    retired.node_retirement_receipt_hash = Some(digest('3'));
    ledger.advance(retired).expect("retired");
    assert!(ledger.all_node_paths_retired());

    let mut illegal = authoritative;
    illegal.stage = CapabilityMigrationStageV1::NodeRetired;
    illegal.recovery_mode = CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority;
    illegal.node_retirement_receipt_hash = Some(digest('3'));
    assert!(illegal.validate().is_err());
}
