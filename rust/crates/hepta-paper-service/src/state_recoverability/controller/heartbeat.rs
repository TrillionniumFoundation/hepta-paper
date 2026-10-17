//! Explicit bounded history refresh. It reuses the controller's actual ready
//! constructor only after real replay and fresh source/head/lease checks.
use super::*;
use std::path::Path;
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    StateRecoverabilityControllerV1<B, O>
{
    pub fn reconcile_existing_heartbeat_history_v1(
        &mut self,
        bundle_path: &Path,
        required_validity_ms: i64,
    ) -> Result<Value> {
        self.check_fatal()?;
        if !(0..=9_007_199_254_740_991).contains(&required_validity_ms) {
            return Err(self.enter_fatal(vec![suffix("required_validity_invalid")]));
        }
        self.lease()?;
        if !self.requirements.is_empty() {
            let pending = self.service.reconcile_pending(self.clock.as_mut());
            self.lease()?;
            match pending {
                Ok(receipt) => {
                    self.recovered(&receipt.value()["recovery"]["finalizedHeads"])?;
                    self.requirements.clear();
                }
                Err(error) => return self.failure(error, "pending-reconciliation"),
            }
        }
        let sources = super::super::history::replay_heartbeat_history(
            &mut self.service,
            bundle_path,
            self.clock.as_mut(),
            self.policy.fresh_snapshot_age_ms,
        );
        self.lease()?;
        let sources = match sources {
            Ok(sources) => sources,
            Err(error) => return self.failure(error, "heartbeat-history-replay"),
        };
        let observation = self.service.observe(&sources, self.clock.as_mut());
        self.lease()?;
        let observation = match observation {
            Ok(value) => value,
            Err(error) => return self.failure(error, "current-head-observation"),
        };
        self.ready(
            "journal-renewed",
            sources,
            observation,
            required_validity_ms,
        )
    }
}
