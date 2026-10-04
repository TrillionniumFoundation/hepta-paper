//! Lifecycle admission from the existing authenticated sequential history.
//! No new counter, journal, reservation writer or dispatch/recovery mechanism.
use super::*;

fn committed(definition: &LocalWorkflowV1, history: &History) -> Result<u64, WorkflowError> {
    if history.results.len() > definition.steps.len() {
        return Err(WorkflowError::History);
    }
    // History replay has authenticated each frozen step/configuration/result.
    // Validation binds exactly one provider call to BrokerExecute and zero to
    // other worker kinds; amended prefixes retain their existing reservations.
    definition.steps[..history.results.len()]
        .iter()
        .try_fold(0_u64, |calls, step| {
            calls
                .checked_add(step.resources.provider_calls)
                .ok_or(WorkflowError::History)
        })
}

pub(super) fn admit(
    definition: &LocalWorkflowV1,
    history: &History,
    index: usize,
) -> Result<(), WorkflowError> {
    let Some(budget) = definition.provider_call_budget else {
        return Ok(());
    };
    if index != history.results.len() {
        return Err(WorkflowError::History);
    }
    let step = definition.steps.get(index).ok_or(WorkflowError::History)?;
    let total = committed(definition, history)?
        .checked_add(step.resources.provider_calls)
        .ok_or(WorkflowError::History)?;
    if total > budget.maximum_calls {
        return Err(WorkflowError::ProviderCallBudgetExhausted);
    }
    Ok(())
}

pub(super) fn usage(
    definition: &LocalWorkflowV1,
    history: &History,
) -> Result<Option<WorkflowProviderCallUsageV1>, WorkflowError> {
    let Some(budget) = definition.provider_call_budget else {
        return Ok(None);
    };
    let committed_calls = committed(definition, history)?;
    let reserved_calls =
        if plan_path(&definition.template.state_directory, history.results.len()).exists() {
            committed_calls
                .checked_add(
                    definition
                        .steps
                        .get(history.results.len())
                        .ok_or(WorkflowError::History)?
                        .resources
                        .provider_calls,
                )
                .ok_or(WorkflowError::History)?
        } else {
            committed_calls
        };
    if reserved_calls > budget.maximum_calls {
        return Err(WorkflowError::History);
    }
    Ok(Some(WorkflowProviderCallUsageV1 {
        version: 1,
        maximum_calls: budget.maximum_calls,
        committed_calls,
        reserved_calls,
    }))
}
