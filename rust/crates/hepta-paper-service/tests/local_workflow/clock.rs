use super::*;
use hepta_control_plane::ControlPlaneError;

fn prepared_count(temp: &Temp) -> usize {
    fs::read_dir(temp.state().join("attempts"))
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext == "prepared")
        })
        .count()
}

#[test]
fn workflow_clock_expires_after_real_preparation_without_a_commit_or_relaunch() {
    let (temp, digest) = fixture();
    let mut clock = || {
        Ok(if prepared_count(&temp) > 0 {
            100_000
        } else {
            1_100
        })
    };
    assert!(matches!(
        operate_local_workflow_with_clock_v1(
            &temp.state(),
            &digest,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut clock,
        ),
        Err(WorkflowError::Service(
            ServiceError::ControlRequiresInspection { .. }
        ))
    ));
    let before = status(&temp, &digest);
    assert_eq!(before.committed_steps, 0);
    assert_eq!(before.budget_remaining_microusd, 100);
    assert!(before.pending_step);
    assert_eq!(prepared_count(&temp), 1);
    let files = attempt_count(&temp);
    // Reopening with the actual expired clock cannot adopt an old observation.
    assert!(
        operate_local_workflow_with_clock_v1(
            &temp.state(),
            &digest,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut || Ok(100_000),
        )
        .is_err()
    );
    assert_eq!(attempt_count(&temp), files);
    assert_eq!(status(&temp, &digest).committed_steps, 0);
}

#[test]
fn workflow_samples_clock_between_steps_and_preserves_prior_commit() {
    let (temp, digest) = fixture();
    let mut clock = || {
        Ok(if prepared_count(&temp) > 1 {
            100_000
        } else {
            1_100
        })
    };
    assert!(
        operate_local_workflow_with_clock_v1(
            &temp.state(),
            &digest,
            WorkflowActionV1::Advance { through_steps: 2 },
            &mut clock,
        )
        .is_err()
    );
    let progress = status(&temp, &digest);
    assert_eq!(progress.committed_steps, 1);
    assert_eq!(progress.budget_remaining_microusd, 99);
    assert_eq!(prepared_count(&temp), 2);
    assert!(progress.pending_step);
}

#[test]
fn readonly_workflow_does_not_need_a_clock_and_live_success_preserves_all_steps() {
    let (temp, digest) = fixture();
    let progress = operate_local_workflow_with_clock_v1(
        &temp.state(),
        &digest,
        WorkflowActionV1::Status,
        &mut || Err(ControlPlaneError::PersistenceInvalid),
    )
    .unwrap();
    assert_eq!(progress.committed_steps, 0);
    let mut tick = 1_100;
    let done = operate_local_workflow_with_clock_v1(
        &temp.state(),
        &digest,
        WorkflowActionV1::Advance { through_steps: 7 },
        &mut || {
            tick += 1;
            Ok(tick)
        },
    )
    .unwrap();
    assert_eq!(done.committed_steps, 7);
    assert_eq!(done.budget_remaining_microusd, 93);
    assert_eq!(done.campaign_state, CampaignStateV1::Completed);
    assert!(!done.production_activation && !done.node_retirement_verified);
}

#[test]
fn workflow_amendment_revalidates_old_lease_and_preserves_history_on_late_failure() {
    for times in [
        [Some(1100), Some(1200), Some(100_000)],
        [Some(1100), Some(1200), Some(1199)],
        [Some(1100), Some(1200), None],
    ] {
        let (temp, digest) = fixture();
        let mut observations = times.into_iter();
        assert!(matches!(
            amend_local_workflow_with_clock_v1(&temp.state(), &digest, amendment(0), &mut || {
                observations
                    .next()
                    .flatten()
                    .ok_or(ControlPlaneError::PersistenceInvalid)
            },),
            Err(WorkflowError::Conflict)
        ));
        let after = status(&temp, &digest);
        assert_eq!(after.campaign_revision, 0);
        assert_eq!(after.budget_remaining_microusd, 100);
        assert_eq!(after.amendment_count, 0);
        assert_eq!(attempt_count(&temp), 0);
    }
}

#[test]
fn workflow_live_amendment_replays_without_clock_and_continues_after_old_expiry() {
    let (temp, digest) = fixture();
    let request = amendment(0);
    let mut tick = 1100;
    let receipt =
        amend_local_workflow_with_clock_v1(&temp.state(), &digest, request.clone(), &mut || {
            tick += 1;
            Ok(tick)
        })
        .unwrap();
    assert_eq!(tick, 1103);
    let replay = amend_local_workflow_with_clock_v1(&temp.state(), &digest, request, &mut || {
        Err(ControlPlaneError::PersistenceInvalid)
    })
    .unwrap();
    assert_eq!(receipt, replay);
    let progress = operate_local_workflow_with_clock_v1(
        &temp.state(),
        &receipt.definition_hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        &mut || Ok(100_001),
    )
    .unwrap();
    assert_eq!(progress.committed_steps, 7);
    assert_eq!(progress.budget_remaining_microusd, 143);
    assert_eq!(progress.amendment_count, 1);
    assert!(!progress.production_activation && !progress.node_retirement_verified);
}

#[test]
fn local_cli_uses_live_time_for_explicit_renewal_and_lifecycle() {
    let temp = Temp::new();
    let now = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    let mut def = definition(&temp);
    def.template.observed_at_unix_ms = now;
    def.template.writer_lease.expires_at_unix_ms = now + 600_000;
    let digest = initialize_local_workflow_v1(def).unwrap();
    let mut request = amendment(0);
    request.lease_expires_at_unix_ms = now + 900_000;
    let input = temp.0.join("renewal.json");
    fs::write(&input, serde_json::to_vec(&request).unwrap()).unwrap();
    fs::set_permissions(&input, fs::Permissions::from_mode(0o600)).unwrap();
    let invoke = |action: &str, hash: &hepta_codex_protocol::Sha256Digest, arg: &str| {
        Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
            .arg(action)
            .arg(temp.state())
            .arg(hash.as_str())
            .arg(arg)
            .output()
            .unwrap()
    };
    let first = invoke("amend", &digest, input.to_str().unwrap());
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let receipt: WorkflowAmendmentReceiptV1 = serde_json::from_slice(&first.stdout).unwrap();
    assert!(receipt.recorded_at_unix_ms >= now);
    assert_eq!(
        invoke("amend", &digest, input.to_str().unwrap()).stdout,
        first.stdout
    );
    let next = &receipt.definition_hash;
    for (action, argument) in [
        ("advance", "1"),
        ("pause", "2"),
        ("resume", "3"),
        ("cancel", "4"),
    ] {
        let out = invoke(action, next, argument);
        assert!(
            out.status.success(),
            "{action}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let progress = status(&temp, next);
    assert_eq!(progress.campaign_state, CampaignStateV1::Cancelled);
    assert_eq!(progress.committed_steps, 1);
    assert_eq!(progress.amendment_count, 1);
    assert_eq!(progress.budget_remaining_microusd, 149);
    assert!(!invoke("resume", next, "5").status.success());
    // The no-NOW route must not silently reuse historical fixture time.
    let (expired, old) = fixture();
    let out = Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
        .arg("amend")
        .arg(expired.state())
        .arg(old.as_str())
        .arg(input)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert_eq!(status(&expired, &old).amendment_count, 0);
}
