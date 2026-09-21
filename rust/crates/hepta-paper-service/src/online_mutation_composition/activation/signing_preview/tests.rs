use super::*;
fn shadow() -> DurableCutoverStateV1 {
    DurableCutoverStateV1 {
        version: 1,
        cutover_id: "native-preview".into(),
        database_path: "/srv/runtime/hepta-paper.sqlite".into(),
        mode: DurableCutoverModeV1::Production,
        phase: DurableCutoverPhaseV1::ShadowVerified,
        old_writer_id: "node".into(),
        new_writer_id: LOCAL_RECONCILIATION_WRITER_ID_V1.into(),
        writer_id: None,
        generation: 2,
        token: "native-preview:2".into(),
        revision: 3,
        shadow_cases: 2,
        shadow_mismatches: 0,
        canary_scopes: vec![],
        production_activation: false,
        activation_receipt_hash: None,
    }
}
fn preview(state: &DurableCutoverStateV1) -> Result<DurableCutoverStateV1> {
    prospective_canary(
        state,
        Path::new("/srv/external-cutover"),
        &format!("sha256:{}", "a".repeat(64)).parse().unwrap(),
    )
}
#[test]
fn prospective_state_is_a_closed_next_epoch_without_a_receipt() {
    let before = shadow();
    let after = preview(&before).unwrap();
    assert_eq!(before.phase, DurableCutoverPhaseV1::ShadowVerified);
    assert_eq!(before.writer_id, None);
    assert_eq!(after.generation, 3);
    assert_eq!(after.revision, 4);
    assert_eq!(after.token, "native-preview:3");
    assert_eq!(after.activation_receipt_hash, None);
    assert_eq!(after.canary_scopes, [RECONCILIATION_WRITER_SCOPE_V1]);
}
#[test]
fn incompatible_or_overflowing_shadow_state_cannot_preview_a_native_subject() {
    for name in [
        "local",
        "canary",
        "writer",
        "scope",
        "active",
        "receipt",
        "new-writer",
        "token",
        "generation-zero",
        "revision-zero",
        "generation-max",
        "revision-max",
        "shadow-zero",
        "mismatch",
    ] {
        let mut value = shadow();
        match name {
            "local" => value.mode = DurableCutoverModeV1::LocalDrill,
            "canary" => value.phase = DurableCutoverPhaseV1::Canary,
            "writer" => value.writer_id = Some("node".into()),
            "scope" => value
                .canary_scopes
                .push(RECONCILIATION_WRITER_SCOPE_V1.into()),
            "active" => value.production_activation = true,
            "receipt" => value.activation_receipt_hash = Some("copied".into()),
            "new-writer" => value.new_writer_id = "other".into(),
            "token" => value.token = "other:2".into(),
            "generation-zero" => {
                value.generation = 0;
                value.token = "native-preview:0".into();
            }
            "revision-zero" => value.revision = 0,
            "generation-max" => {
                value.generation = MAX_SAFE;
                value.token = format!("native-preview:{MAX_SAFE}");
            }
            "revision-max" => value.revision = MAX_SAFE,
            "shadow-zero" => value.shadow_cases = 0,
            "mismatch" => value.shadow_mismatches = 1,
            _ => unreachable!(),
        }
        assert!(preview(&value).is_err(), "{name}");
    }
}
