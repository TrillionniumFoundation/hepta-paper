//! Normal reconciliation can select a historical heartbeat snapshot without
//! converting historical source reports into a current epoch.
use super::*;

impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    StateRecoverabilityControllerV1<B, O>
{
    pub(super) fn automatic_heartbeat_history(
        &mut self,
        required: i64,
        now: i64,
    ) -> Result<Option<Value>> {
        let result = super::super::history::replay_best_heartbeat_history(
            &mut self.service,
            self.clock.as_mut(),
            now,
            self.policy.fresh_snapshot_age_ms,
        );
        self.lease()?;
        let sources = match result {
            Ok(Some(sources)) => sources,
            Ok(None) => return Ok(None),
            Err(error) => return self.failure(error, "heartbeat-history-replay").map(Some),
        };
        let observation = self.service.observe(&sources, self.clock.as_mut());
        self.lease()?;
        let observation = match observation {
            Ok(value) => value,
            Err(error) => return self.failure(error, "current-head-observation").map(Some),
        };
        self.ready("journal-renewed", sources, observation, required)
            .map(Some)
    }
}
