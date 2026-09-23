//! Explicit, non-destructive recovery of unpublished provisioning staging.
//! The selected byte/inode snapshot is quarantined, never adopted as a runtime.
use super::{Result, error, files, input_hash, publication::Target, valid_hash};
use nix::{
    errno::Errno,
    fcntl::{RenameFlags, renameat2},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    os::fd::AsFd,
    path::{Path, PathBuf},
};
mod inventory;
use inventory::Snapshot;
const INVALID: &str = "autonomous_state_provisioning_recovery_request_invalid";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u32,
    kind: String,
    action: String,
    runtime_root: PathBuf,
    staging_root: PathBuf,
    execute: bool,
    expected_plan_hash: Option<String>,
}
impl Request {
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.kind != "NativeStateProvisioningRecoveryRequestV1"
            || !self.runtime_root.is_absolute()
            || !self.staging_root.is_absolute()
        {
            return Err(error(INVALID));
        }
        match self.action.as_str() {
            "inspect" if !self.execute && self.expected_plan_hash.is_none() => Ok(()),
            "quarantine"
                if self.execute && self.expected_plan_hash.as_deref().is_some_and(valid_hash) =>
            {
                Ok(())
            }
            _ => Err(error(INVALID)),
        }
    }
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn check_names(staging: &Path, quarantine: &Path, at_source: bool) -> Result<()> {
    if present(staging)? != at_source || present(quarantine)? == at_source {
        return Err(error(
            "autonomous_state_provisioning_recovery_placement_changed",
        ));
    }
    Ok(())
}
fn names(request: &Request, target: &Target) -> Result<(PathBuf, PathBuf)> {
    let staging = files::absolute(&request.staging_root)?;
    if staging != request.staging_root || staging.parent() != target.path.parent() {
        return Err(error(INVALID));
    }
    let prefix = format!(".{}.provisioning-", target.name);
    let suffix = staging
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(&prefix))
        .ok_or_else(|| error(INVALID))?;
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error(INVALID));
    }
    let quarantine = target
        .path
        .parent()
        .ok_or_else(|| error(INVALID))?
        .join(format!(
            ".{}.quarantined-provisioning-{suffix}",
            target.name
        ));
    Ok((staging, quarantine))
}
fn planned(
    target: &Target,
    staging: &Path,
    quarantine: &Path,
    snapshot: &Snapshot,
) -> Result<Value> {
    let mut plan = json!({"version":1,"kind":"NativeStateProvisioningRecoveryPlanV1",
        "operation":"quarantine_unpublished_staging","runtimeRoot":target.path,
        "stagingRoot":staging,"quarantineRoot":quarantine,"parentIdentity":target.observation()?,
        "inventory":snapshot.observation(),"deletionAllowed":false,
        "runtimeAdoptionAllowed":false,"productionActivation":false,"nodeRetirement":false});
    plan["recoveryPlanHash"] = json!(input_hash("NativeStateProvisioningRecoveryPlanV1", &plan)?);
    Ok(plan)
}
fn receipt(plan: &Value) -> Result<Value> {
    let mut value = json!({"version":1,"kind":"NativeStateProvisioningRecoveryReceiptV1",
        "recoveryPlanHash":plan["recoveryPlanHash"],"runtimeRoot":plan["runtimeRoot"],
        "stagingRoot":plan["stagingRoot"],"quarantineRoot":plan["quarantineRoot"],
        "state":"quarantined","bytesPreserved":true,"deletionPerformed":false,
        "freshRuntimeInstalled":false,"productionActivation":false,"nodeRetirement":false});
    value["recoveryReceiptHash"] = json!(input_hash(
        "NativeStateProvisioningRecoveryReceiptV1",
        &value
    )?);
    Ok(value)
}
fn recover(
    request: &Request,
    revalidate_request: &impl Fn() -> Result<()>,
    hook: &mut impl FnMut(&str) -> Result<()>,
) -> Result<Value> {
    request.validate()?;
    let target = Target::open_parent(&request.runtime_root)?;
    let _lock = target.lock()?;
    target.require_absent()?;
    let (staging, quarantine) = names(request, &target)?;
    let (source_exists, destination_exists) = (present(&staging)?, present(&quarantine)?);
    if source_exists == destination_exists {
        return Err(error(
            "autonomous_state_provisioning_recovery_missing_or_conflicting_names",
        ));
    }
    let current = if source_exists { &staging } else { &quarantine };
    let mut snapshot = Snapshot::capture(current, target.parent.metadata()?.dev())?;
    target.require_absent()?;
    revalidate_request()?;
    let plan = planned(&target, &staging, &quarantine, &snapshot)?;
    if request.action == "inspect" {
        snapshot.verify(current)?;
        check_names(&staging, &quarantine, source_exists)?;
        target.require_absent()?;
        return Ok(
            json!({"version":1,"kind":"NativeStateProvisioningRecoveryInspectionV1",
            "state":if source_exists {"retained_staging"} else {"quarantined"},
            "plan":plan,"mutationPerformed":false}),
        );
    }
    if request.expected_plan_hash.as_deref() != plan["recoveryPlanHash"].as_str() {
        return Err(error(
            "autonomous_state_provisioning_recovery_plan_mismatch",
        ));
    }
    // Flushing retained file owners is part of explicit mutation, never inspection.
    snapshot.flush()?;
    if !source_exists {
        snapshot.verify(&quarantine)?;
        check_names(&staging, &quarantine, false)?;
        target.parent.sync_all()?;
        target.require_absent()?;
        revalidate_request()?;
        return receipt(&plan);
    }
    let mut moved = Some(false);
    let outcome = (|| {
        hook("before_quarantine")?;
        revalidate_request()?;
        snapshot.verify(&staging)?;
        target.require_absent()?;
        match renameat2(
            target.parent.as_fd(),
            staging.file_name().ok_or_else(|| error(INVALID))?,
            target.parent.as_fd(),
            quarantine.file_name().ok_or_else(|| error(INVALID))?,
            RenameFlags::RENAME_NOREPLACE,
        ) {
            Ok(()) => moved = Some(true),
            Err(Errno::EEXIST) => {
                return Err(error("autonomous_state_provisioning_quarantine_collision"));
            }
            Err(_) => {
                moved = None;
                return Err(error(
                    "autonomous_state_provisioning_quarantine_indeterminate",
                ));
            }
        }
        hook("after_quarantine")?;
        target.parent.sync_all()?;
        snapshot.verify(&quarantine)?;
        check_names(&staging, &quarantine, false)?;
        target.require_absent()?;
        revalidate_request()?;
        hook("after_quarantine_sync")?;
        receipt(&plan)
    })();
    outcome.map_err(|failure| error(format!("{}; quarantineState={}; stagingRoot={}; quarantineRoot={}; automaticRetryAllowed=false",
        failure.0, match moved {Some(true)=>"quarantined",Some(false)=>"not_quarantined",None=>"indeterminate"},
        staging.display(),quarantine.display())))
}
use std::os::unix::fs::MetadataExt;
/// Runs the explicit recovery profile of the existing provisioning command.
/// Requires exactly `--recover-staging ABSOLUTE_REQUEST_JSON`; no credentials,
/// database connection, shell, deletion or runtime adoption are reachable here.
pub fn recover_staging_cli_v1(argv: &[String]) -> Result<Value> {
    if argv.len() != 2 || argv[0] != "--recover-staging" || !Path::new(&argv[1]).is_absolute() {
        return Err(error(INVALID));
    }
    let file = files::Snapshot::read(Path::new(&argv[1]))?;
    if file.bytes.len() > 65_536 {
        return Err(error(INVALID));
    }
    let raw = crate::sqlite_mutation_coordinator::authority::files::parse(&file.bytes, INVALID)
        .map_err(|_| error(INVALID))?;
    let request: Request = serde_json::from_value(raw)?;
    recover(
        &request,
        &|| file.assert_current().map_err(Into::into),
        &mut |_| Ok(()),
    )
}
#[cfg(test)]
mod tests;
