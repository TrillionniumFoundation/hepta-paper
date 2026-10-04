//! Ordinary queries over the incumbent campaign business tables. No workflow
//! journal is substituted, and no writer/provider/release authority is admitted.
mod arguments;
mod json;
mod presenter;
mod rows;

/// Reuse the incumbent row contract for fixed sibling business observations.
pub(crate) fn project_one_shot_campaign_row_v1(
    row: &hepta_legacy_compatibility::ProductionJsonValue,
) -> Result<hepta_legacy_compatibility::ProductionJsonValue, String> {
    rows::campaign(row)
}
pub(crate) fn project_one_shot_node_row_v1(
    row: &hepta_legacy_compatibility::ProductionJsonValue,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<hepta_legacy_compatibility::ProductionJsonValue, String> {
    rows::node(row, cancelled)
}

use crate::{
    automation_runtime_reconciliation::{
        open_database,
        ordinary::{MAX_OUTPUT_BYTES, ReconciliationReadControlV1},
        rows_with_control,
    },
    native_workspace::current_native_command_workspace_root_v1,
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    runtime_source_cas::observation::SourceObservation,
    workspace_status::{WorkspaceLayoutOptionsV1, resolve_workspace_layout_v1},
};
use arguments::Arguments;
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json, parse_production_json_v1,
    production_json_pretty_with_limits_v1,
};
use hepta_readonly_control::node_schema::NODE_MIGRATIONS_V1;
use json::{field, number, object, same_scalar, string};
use rusqlite::{Connection, Params, params};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};

fn selected<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
    control: &ReconciliationReadControlV1,
) -> Result<Vec<Json>, String> {
    rows_with_control(connection, sql, params, Some(control))
        .map_err(|error| error.to_string())?
        .iter()
        .map(|value| {
            control.checkpoint().map_err(|error| error.to_string())?;
            let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
            parse_production_json_v1(&bytes).map_err(|error| error.to_string())
        })
        .collect()
}
fn schema(
    connection: &Connection,
    source: &mut SourceObservation<'_>,
    control: &ReconciliationReadControlV1,
) -> Result<(), String> {
    let observed = selected(
        connection,
        "SELECT version,name,migration_sha256 FROM schema_migrations WHERE version IN (21,22,23,24,25) ORDER BY version",
        [],
        control,
    )?;
    let mut blockers = Vec::new();
    for migration in NODE_MIGRATIONS_V1
        .iter()
        .filter(|migration| migration.version >= 21)
    {
        control.checkpoint().map_err(|error| error.to_string())?;
        let relative = format!("store/migrations/{}.sql", migration.name);
        let bytes = source.document(Path::new(&relative))?;
        let hash = string(&format!("sha256:{:x}", Sha256::digest(&bytes)));
        let row = observed
            .iter()
            .find(|row| number(field(row, "version")).ok() == Some(f64::from(migration.version)));
        match row {
            None => blockers.push(format!(
                "scoped_schema_migration_{}_required",
                migration.version
            )),
            Some(row)
                if !same_scalar(field(row, "name"), &string(migration.name))
                    || !same_scalar(field(row, "migration_sha256"), &hash) =>
            {
                blockers.push(format!(
                    "scoped_schema_migration_{}_history_mismatch",
                    migration.version
                ))
            }
            Some(_) => (),
        }
    }
    source.assert_current()?;
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "scoped_schema_version_gate_failed:{}",
            blockers.join(",")
        ))
    }
}
fn nodes(
    connection: &Connection,
    campaign: &str,
    control: &ReconciliationReadControlV1,
) -> Result<Vec<Json>, String> {
    selected(
        connection,
        "SELECT * FROM campaign_nodes WHERE campaign_id=? ORDER BY priority,created_at,node_id",
        [campaign],
        control,
    )?
    .iter()
    .map(|row| {
        control.checkpoint().map_err(|error| error.to_string())?;
        rows::node(row, &control.cancelled)
    })
    .collect()
}
fn limit(options: &Arguments, events: bool) -> Result<f64, String> {
    let default = if events { 50.0 } else { 100.0 };
    let mut value = options
        .value("limit")
        .map_or(Ok(default), |value| number(&string(value)))?;
    // The events service converts first; the repository then applies || 50.
    if events && (value == 0.0 || value.is_nan()) {
        value = 50.0;
    }
    if value.is_nan() {
        return Err("no such column: NaN".into());
    }
    Ok(value.clamp(1.0, 1000.0))
}
fn query(
    connection: &Connection,
    options: &Arguments,
    action: &str,
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    let campaign_id = options.value("campaign-id").unwrap_or("");
    let details = options.flag("details");
    let result = match action {
        "list" => {
            const BASE: &str = "SELECT c.*,CASE WHEN EXISTS(SELECT 1 FROM paper_campaigns n WHERE n.paper_id=c.paper_id AND (n.recovery_of_campaign_id=c.campaign_id OR n.supersedes_campaign_id=c.campaign_id)) THEN 'superseded' ELSE c.status END AS effective_status FROM paper_campaigns c";
            let selected = if let Some(status) = options.value("status") {
                selected(
                    connection,
                    &format!(
                        "{BASE} WHERE c.status=? ORDER BY c.updated_at DESC,c.campaign_id LIMIT ? OFFSET 0"
                    ),
                    params![status, limit(options, false)?],
                    control,
                )?
            } else {
                selected(
                    connection,
                    &format!("{BASE} ORDER BY c.updated_at DESC,c.campaign_id LIMIT ? OFFSET 0"),
                    [limit(options, false)?],
                    control,
                )?
            };
            let mut output = Vec::new();
            for row in selected {
                control.checkpoint().map_err(|error| error.to_string())?;
                let campaign = rows::campaign(&row)?;
                if options.flag("effective")
                    && same_scalar(field(&campaign, "effectiveStatus"), &string("superseded"))
                {
                    continue;
                }
                output.push(if details {
                    campaign
                } else {
                    presenter::campaign(&campaign)?
                });
            }
            Json::Array(output)
        }
        "status" => {
            let campaign = selected(
                connection,
                "SELECT * FROM paper_campaigns WHERE campaign_id=? LIMIT 1",
                [campaign_id],
                control,
            )?
            .first()
            .map_or(Ok(Json::Null), rows::campaign)?;
            presenter::status(campaign, nodes(connection, campaign_id, control)?, details)?
        }
        "events" => {
            let events = if let Some(before) = options.value("before") {
                selected(
                    connection,
                    "SELECT * FROM campaign_events WHERE campaign_id=? AND created_at<? ORDER BY created_at DESC,event_id DESC LIMIT ?",
                    params![campaign_id, before, limit(options, true)?],
                    control,
                )?
            } else {
                selected(
                    connection,
                    "SELECT * FROM campaign_events WHERE campaign_id=? ORDER BY created_at DESC,event_id DESC LIMIT ?",
                    params![campaign_id, limit(options, true)?],
                    control,
                )?
            };
            let mut output = Vec::new();
            for row in events {
                control.checkpoint().map_err(|error| error.to_string())?;
                let event = rows::event(&row)?;
                output.push(if details {
                    event
                } else {
                    presenter::event(&event)
                });
            }
            Json::Array(output)
        }
        "logs" => {
            let node = nodes(connection, campaign_id, control)?
                .into_iter()
                .find(|node| {
                    options
                        .value("node-id")
                        .is_some_and(|value| same_scalar(field(node, "nodeId"), &string(value)))
                        || options
                            .value("kind")
                            .is_some_and(|value| same_scalar(field(node, "kind"), &string(value)))
                })
                .ok_or("campaign node not found for log query")?;
            presenter::log(node, details)?
        }
        _ => return Err("native_campaign_action_not_implemented".into()),
    };
    Ok(object([
        ("status", string(&format!("paper_campaign_{action}"))),
        ("result", result),
    ]))
}
fn inspect_with_control(
    argv: &[String],
    control: &ReconciliationReadControlV1,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    control.checkpoint().map_err(|error| error.to_string())?;
    let options = Arguments::parse(argv)?;
    if options.flag("help") {
        return Ok(OrdinaryReadonlyOutputV1 {
            stdout: include_bytes!("ordinary_campaign_query/help.txt").to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }
    let action = options.validate_query()?;
    let workspace = current_native_command_workspace_root_v1(None)?;
    let mut environment = BTreeMap::new();
    for name in [
        "HEPTA_PAPER_ASSET_ROOT",
        "HEPTA_PAPER_RUNTIME_ROOT",
        "PAPER_FACTORY_LEGACY_ROOT",
    ] {
        match std::env::var(name) {
            Ok(value) => {
                environment.insert(name.to_owned(), value);
            }
            Err(std::env::VarError::NotPresent) => (),
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err("campaign_query_root_encoding_invalid".into());
            }
        }
    }
    let layout = resolve_workspace_layout_v1(
        &workspace,
        // The ordinary Node registry launches this strict child at its own
        // physical workspace ROOT, regardless of the invoking caller's cwd.
        &workspace,
        &environment,
        &WorkspaceLayoutOptionsV1 {
            asset_root: options.value("root"),
            runtime_root: options.value("runtime-root"),
            legacy_root: None,
        },
    )?;
    if options.flag("execute") && !layout.physically_decoupled {
        return Err(format!(
            "workspace_layout_not_physically_decoupled:{}",
            layout.decoupling_blockers.join(",")
        ));
    }
    let database = PathBuf::from(&layout.roots.runtime_root).join("hepta-paper.sqlite");
    if !database.try_exists().map_err(|error| error.to_string())? {
        return Err(format!(
            "Read-only paper store missing: {}",
            database.display()
        ));
    }
    control.checkpoint().map_err(|error| error.to_string())?;
    let mut source =
        SourceObservation::new_with_deadline(&workspace, &control.cancelled, control.deadline)?;
    let retained = hepta_readonly_store::OrdinaryReadOnlyStoreV1::open_with_cancellation(
        &database,
        control.cancelled.clone(),
        control.deadline,
    )
    .map_err(|error| error.to_string())?;
    let connection = open_database(&database).map_err(|error| error.to_string())?;
    control
        .install(&connection)
        .map_err(|error| error.to_string())?;
    let report = schema(&connection, &mut source, control)
        .and_then(|()| query(&connection, &options, action, control));
    drop(connection);
    retained
        .verify_unchanged()
        .map_err(|error| error.to_string())?;
    source.assert_current()?;
    control.checkpoint().map_err(|error| error.to_string())?;
    let report = report?;
    let mut stdout = production_json_pretty_with_limits_v1(
        &report,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: MAX_OUTPUT_BYTES - 1,
            maximum_values: MAX_OUTPUT_BYTES,
            maximum_utf16_units: MAX_OUTPUT_BYTES,
        },
        &control.cancelled,
    )
    .map_err(|error| error.to_string())?;
    control.checkpoint().map_err(|error| error.to_string())?;
    retained
        .verify_unchanged()
        .map_err(|error| error.to_string())?;
    source.assert_current()?;
    control.checkpoint().map_err(|error| error.to_string())?;
    stdout.push(b'\n');
    Ok(OrdinaryReadonlyOutputV1 {
        stdout,
        stderr: Vec::new(),
        exit_code: 0,
    })
}
pub fn inspect_ordinary_campaign_query_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(120))
        .ok_or("campaign_query_deadline_invalid")?;
    inspect_with_control(argv, &ReconciliationReadControlV1::new(cancelled, deadline))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_cancel_and_deadline_refuse_before_discovery() {
        for control in [
            ReconciliationReadControlV1::new(
                Arc::new(AtomicBool::new(true)),
                Instant::now() + Duration::from_secs(60),
            ),
            ReconciliationReadControlV1::new(Arc::new(AtomicBool::new(false)), Instant::now()),
        ] {
            assert!(inspect_with_control(&["--action=list".into()], &control).is_err());
        }
    }
    #[test]
    fn query_authority_is_not_created_by_legal_child_flags() {
        let options =
            Arguments::parse(&["--action=list".into(), "--apply".into(), "--execute".into()])
                .expect("legal incumbent grammar");
        assert_eq!(
            options.validate_query(),
            Err("native_campaign_apply_authority_required".into())
        );
        assert!(Arguments::parse(&["--help".into(), "--unknown".into()]).is_err());
        assert!(
            Arguments::parse(&["--paper=one".into(), "--paper=two".into(), "--help".into()])
                .is_ok()
        );
    }
    #[test]
    fn original_two_stage_event_limit_coercion_and_list_refusal() {
        for value in ["0", "NaN", " "] {
            let options = Arguments::parse(&[format!("--limit={value}")]).expect("grammar");
            assert_eq!(limit(&options, true), Ok(50.0));
        }
        let options = Arguments::parse(&["--limit=NaN".into()]).expect("grammar");
        assert_eq!(limit(&options, false), Err("no such column: NaN".into()));
    }
}
