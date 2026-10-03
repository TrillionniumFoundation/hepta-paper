//! Actual fixed protected/target business state, retained through future
//! execution fences. This observation grants no provider or launch authority.
use super::json::*;
use crate::{
    automation_runtime_reconciliation::ordinary::ReconciliationReadControlV1,
    ordinary_campaign_query::{project_one_shot_campaign_row_v1, project_one_shot_node_row_v1},
    runtime_source_cas::observation::SourceObservation,
};
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json, parse_production_json_v1,
    production_json_resources_v1,
};
use hepta_readonly_store::ReadOnlyStoreV1;
use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};

/// Opening the immutable owner is separate from querying business state so
/// ordinary preflight can verify the retained filesystem snapshot even when
/// the original fixed SQL synchronously refuses malformed JSON.
pub(super) struct OneShotBusinessReadOwnerV1<'a> {
    source: SourceObservation<'a>,
    store: ReadOnlyStoreV1,
    control: ReconciliationReadControlV1,
}
impl<'a> OneShotBusinessReadOwnerV1<'a> {
    pub(super) fn open(
        runtime: &Path,
        cancelled: &'a Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Self, String> {
        let control = ReconciliationReadControlV1::new(Arc::clone(cancelled), deadline);
        control.checkpoint().map_err(|e| e.to_string())?;
        if Instant::now()
            .checked_add(Duration::from_secs(120))
            .is_none_or(|ceiling| deadline > ceiling)
        {
            return Err("one_shot_business_deadline_limit_exceeded".into());
        }
        let mut source = SourceObservation::new_with_deadline(runtime, cancelled, deadline)?;
        if source.root() != runtime {
            return Err("autonomous_research_one_shot_native_store_runtime_root_unsafe".into());
        }
        for leaf in [
            "hepta-paper.sqlite",
            "hepta-paper.sqlite-wal",
            "hepta-paper.sqlite-shm",
            "hepta-paper.sqlite-journal",
        ] {
            let present = source.inventory_probe(Path::new(leaf))?;
            if leaf == "hepta-paper.sqlite" {
                if present.is_none() {
                    return Err(
                        "autonomous_research_one_shot_protected_campaign_store_required".into(),
                    );
                }
            } else if present.is_some() {
                return Err("autonomous_research_one_shot_native_store_sidecar_present".into());
            }
        }
        let store = ReadOnlyStoreV1::open_known_installed_with_cancellation_v1(
            runtime.join("hepta-paper.sqlite"),
            Arc::clone(cancelled),
            deadline,
        )
        .map_err(|e| e.to_string())?;
        let result = Self {
            source,
            store,
            control,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub(super) fn project(&self) -> Result<(Json, Json), String> {
        self.assert_current()?;
        let projection = self
            .store
            .fixed_one_shot_business_rows_v1()
            .map_err(|e| e.to_string())?;
        let row = projection
            .protected_campaign
            .as_ref()
            .ok_or("autonomous_research_one_shot_protected_campaign_missing")?;
        let campaign = project_one_shot_campaign_row_v1(
            &parse_production_json_v1(row.get().as_bytes()).map_err(|e| e.to_string())?,
        )?;
        let mut nodes = Vec::new();
        for row in &projection.nodes {
            self.control.checkpoint().map_err(|e| e.to_string())?;
            nodes.push(project_one_shot_node_row_v1(
                &parse_production_json_v1(row.get().as_bytes()).map_err(|e| e.to_string())?,
                &self.control.cancelled,
            )?);
        }
        let counts_projection = self
            .store
            .fixed_one_shot_business_counts_v1()
            .map_err(|e| e.to_string())?;
        let failed = nodes
            .iter()
            .filter(|node| is_text(field(node, "status"), "failed_terminal"))
            .collect::<Vec<_>>();
        // Measure each projected value through the existing encoder before
        // retaining a hash payload. Move the full campaign/nodes instead of
        // cloning a potentially large projected JSON tree.
        let mut remaining_bytes = 1024 * 1024usize;
        let mut remaining_values = 20_000usize;
        let mut remaining_utf16 = 1024 * 1024usize;
        for value in std::iter::once(&campaign).chain(nodes.iter()) {
            let measured = production_json_resources_v1(
                value,
                ProductionJsonEncodingLimitsV1 {
                    maximum_bytes: remaining_bytes,
                    maximum_values: remaining_values,
                    maximum_utf16_units: remaining_utf16,
                },
                &self.control.cancelled,
            )
            .map_err(|e| e.to_string())?;
            remaining_bytes = remaining_bytes
                .checked_sub(measured.bytes)
                .ok_or("one_shot_business_projection_bound")?;
            remaining_values = remaining_values
                .checked_sub(measured.values)
                .ok_or("one_shot_business_projection_bound")?;
            remaining_utf16 = remaining_utf16
                .checked_sub(measured.utf16_units)
                .ok_or("one_shot_business_projection_bound")?;
        }
        let campaign_id = field(&campaign, "campaignId").clone();
        let campaign_status = field(&campaign, "status").clone();
        let failed_count = failed.len();
        let failure_class = if failed_count == 1 {
            field(failed[0], "failureClass").clone()
        } else {
            Json::Null
        };
        let skipped_count = nodes
            .iter()
            .filter(|node| is_text(field(node, "status"), "skipped"))
            .count();
        let active_count = nodes
            .iter()
            .filter(|node| {
                is_text(field(node, "status"), "leased")
                    || is_text(field(node, "status"), "running")
            })
            .count();
        let leased_count = nodes
            .iter()
            .filter(|node| !matches!(field(node, "leaseOwner"), Json::Null))
            .count();
        let counts = object([
            ("campaign", campaign),
            ("nodes", Json::Array(nodes)),
            (
                "resourceLeaseCount",
                Json::Number(counts_projection.resource_lease_count as f64),
            ),
            (
                "waiterCount",
                Json::Number(counts_projection.waiter_count as f64),
            ),
            (
                "submissionCount",
                Json::Number(counts_projection.submission_count as f64),
            ),
            (
                "outboxCount",
                Json::Number(counts_projection.outbox_count as f64),
            ),
            (
                "ledgerCount",
                Json::Number(counts_projection.ledger_count as f64),
            ),
        ]);
        let logical = hash(
            "AutonomousResearchOneShotProtectedCampaignLogicalState",
            &counts,
            &self.control.cancelled,
        )?;
        let definition = object([
            ("version", Json::Number(1.0)),
            ("campaignId", campaign_id),
            ("status", campaign_status),
            ("failedTerminalNodeCount", Json::Number(failed_count as f64)),
            ("skippedNodeCount", Json::Number(skipped_count as f64)),
            ("activeNodeCount", Json::Number(active_count as f64)),
            ("nodeLeaseCount", Json::Number(leased_count as f64)),
            (
                "resourceLeaseCount",
                Json::Number(counts_projection.resource_lease_count as f64),
            ),
            (
                "waiterCount",
                Json::Number(counts_projection.waiter_count as f64),
            ),
            ("failureClass", failure_class),
            (
                "submissionCount",
                Json::Number(counts_projection.submission_count as f64),
            ),
            (
                "outboxCount",
                Json::Number(counts_projection.outbox_count as f64),
            ),
            (
                "ledgerCount",
                Json::Number(counts_projection.ledger_count as f64),
            ),
            ("logicalStateHash", string(&logical)),
        ]);
        let target = self
            .store
            .fixed_one_shot_target_campaign_v1()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map_or(Ok(Json::Null), |row| {
                project_one_shot_campaign_row_v1(
                    &parse_production_json_v1(row.get().as_bytes()).map_err(|e| e.to_string())?,
                )
            })?;
        self.assert_current()?;
        Ok((definition, target))
    }
    pub fn assert_current(&self) -> Result<(), String> {
        self.control.checkpoint().map_err(|e| e.to_string())?;
        self.source
            .require_control_context_v1(&self.control.cancelled, self.control.deadline)?;
        self.source.assert_current()?;
        self.store.verify_unchanged().map_err(|e| e.to_string())?;
        self.control.checkpoint().map_err(|e| e.to_string())
    }
}

pub struct OneShotBusinessObservationV1<'a> {
    owner: OneShotBusinessReadOwnerV1<'a>,
    definition: Json,
    target: Json,
}
impl<'a> OneShotBusinessObservationV1<'a> {
    pub fn capture(
        runtime: &Path,
        cancelled: &'a Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Self, String> {
        let owner = OneShotBusinessReadOwnerV1::open(runtime, cancelled, deadline)?;
        let (definition, target) = owner.project()?;
        Ok(Self {
            owner,
            definition,
            target,
        })
    }
    pub fn protected_definition(&self) -> &Json {
        &self.definition
    }
    pub fn target_campaign(&self) -> &Json {
        &self.target
    }
    pub fn assert_current(&self) -> Result<(), String> {
        self.owner.assert_current()
    }
}

#[cfg(test)]
mod tests;
