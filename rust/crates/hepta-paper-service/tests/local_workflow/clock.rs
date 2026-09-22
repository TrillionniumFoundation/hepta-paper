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
