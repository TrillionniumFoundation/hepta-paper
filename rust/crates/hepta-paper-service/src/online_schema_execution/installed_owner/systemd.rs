//! Closed installed service-manager adapter. The existing bounded D-Bus wire
//! owner completes and destroys every reader before any migration kernel scope.
//! Continued guards inspect retained kernel/file facts, never receive bus FDs.
use super::{
    SchemaOperationIdentityV1,
    barrier::{AuthorityBarrier, Barrier, DROP_IN_NAME},
    cgroup::ObservedCgroup,
    installation::{AUTHORITY_UNIT_V1, ObservedInstalledSchemaProfileV1, SourceUnitV1},
};
use crate::{
    local_state_authority_client::{LocalStateAuthorityClientError, manager},
    online_schema_execution::maintenance::normalization::finalization::recovery::restart::PreparedSchemaTargetRestartV2,
    sqlite_mutation_coordinator::{Result, error},
};
use futures_lite::StreamExt;
use nix::{
    errno::Errno,
    poll::{PollFd, PollFlags, PollTimeout, poll},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::fd::{AsFd, OwnedFd},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use zbus::{
    AsyncDrop, Connection, MatchRule, MessageStream,
    connection::{AuthMechanism, Builder},
    zvariant::OwnedObjectPath,
};

const MANAGER_PATH: &str = "/org/freedesktop/systemd1";
const MANAGER_INTERFACE: &str = "org.freedesktop.systemd1.Manager";
const UNIT_INTERFACE: &str = "org.freedesktop.systemd1.Unit";
const SERVICE_INTERFACE: &str = "org.freedesktop.systemd1.Service";
const CODE: &str = "autonomous_research_installed_schema_manager_invalid_or_changed";
const SOURCE_DROP_IN: &str = "89-hepta-paper-native-schema-authority-source.conf";
const TARGET_DROP_IN: &str = "91-hepta-paper-native-schema-authority-target.conf";
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(CODE)
}
fn bus_error(
    _: LocalStateAuthorityClientError,
) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    invalid()
}
fn bus_invalid() -> LocalStateAuthorityClientError {
    manager::installed_manager_error()
}
type BusResult<T> = std::result::Result<T, LocalStateAuthorityClientError>;
type ExecStart = (String, Vec<String>, bool, u64, u64, u64, u64, u32, i32, i32);

struct UnitObservation {
    active: String,
    substate: String,
    main_pid: u32,
    control_pid: u32,
    job: u32,
    cgroup: String,
}

/// Minted solely by an actual typed authority StopUnit completion and retained
/// original cgroup observation. It cannot be constructed from CLI/JSON facts.
pub(crate) struct HeldStoppedInstalledAuthorityV1<'h, 'p> {
    maintenance: &'h HeldInstalledSchemaMaintenanceV1<'p>,
    cgroup: ObservedCgroup,
    barrier: AuthorityBarrier,
}
impl HeldStoppedInstalledAuthorityV1<'_, '_> {
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.maintenance.assert_current()?;
        self.barrier.assert_current()?;
        self.cgroup.assert_empty()?;
        self.maintenance.assert_current()
    }
    pub(crate) fn profile(&self) -> &ObservedInstalledSchemaProfileV1 {
        self.maintenance.profile
    }
    pub(crate) fn operation(&self) -> &SchemaOperationIdentityV1 {
        &self.maintenance.operation
    }
}
impl UnitObservation {
    fn frame(&self, unit: &str) -> Value {
        json!({"unit":unit,"activeState":self.active,"subState":self.substate,"mainPid":self.main_pid,"controlPid":self.control_pid,"job":self.job,"cgroup":self.cgroup})
    }
    fn quiescent_for(&self, expected: &SourceUnitV1) -> bool {
        self.quiescent()
            || (super::installation::fixed_root_layout_oneshot(expected)
                && self.active == "active"
                && self.substate == "exited"
                && self.main_pid == 0
                && self.control_pid == 0
                && self.job == 0)
    }
    fn quiescent(&self) -> bool {
        matches!(self.active.as_str(), "inactive" | "failed")
            && matches!(self.substate.as_str(), "dead" | "failed")
            && self.main_pid == 0
            && self.control_pid == 0
            && self.job == 0
    }
}

/// A genuine root profile is borrowed throughout the maintenance lifetime.
/// No Deserialize/Clone, caller readiness predicate or serialized constructor.
pub(crate) struct HeldInstalledSchemaMaintenanceV1<'a> {
    profile: &'a ObservedInstalledSchemaProfileV1,
    barrier: Barrier,
    boot: manager::BootObservation,
    manager_pidfd: OwnedFd,
    cgroups: Vec<(String, ObservedCgroup)>,
    manager_owner: String,
    operation: SchemaOperationIdentityV1,
    original: Option<super::original::OriginalManagerV2>,
}
impl HeldInstalledSchemaMaintenanceV1<'_> {
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.profile.assert_current()?;
        self.barrier.assert_current()?;
        self.boot.assert_current().map_err(bus_error)?;
        manager_alive(&self.manager_pidfd)?;
        for (_, observed) in &self.cgroups {
            observed.assert_empty()?;
        }
        manager_alive(&self.manager_pidfd)?;
        self.boot.assert_current().map_err(bus_error)
    }
    pub(crate) fn diagnostics(&self) -> Value {
        json!({"version":1,"kind":"HeldInstalledSchemaMaintenanceObservationV1",
            "bootId":self.boot.identity(),"managerOwner":self.manager_owner,
            "transitionId":self.operation.transition_id,"planHash":self.operation.plan_hash,"profileSha256":self.operation.profile_sha256,
            "managerUid":0,"managerPid":1,"originalManagerPidfdHeld":true,
            "sourceUnits":self.cgroups.iter().map(|(unit,group)| json!({"unit":unit,
                "cgroup":group.diagnostics()})).collect::<Vec<_>>(),
            "barrier":self.barrier.diagnostics(),"busClosedBeforeKernelScopes":true,
            "continuedCheck":"retained_profile_barrier_boot_pidfd_cgroup_only",
            "releaseAuthority":false,"submissionAuthority":false,"productionActivation":false})
    }
    pub(super) fn assert_early_rollback_origin(&self) -> Result<()> {
        self.assert_current()?;
        let original = self.original.as_ref().ok_or_else(invalid)?;
        original.manager_identity(self.boot.identity(), &self.manager_owner)?;
        original.assert_reversible_units()?;
        original.assert_authority_untouched()?;
        let deadline = Instant::now() + Duration::from_secs(120);
        exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.manager_owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            let authority = &self.profile.authority_restart().source_unit;
            let frame = observe_unit(connection, &owner, authority, &[], None, true, deadline)
                .await?
                .frame(&authority.unit);
            if frame != *original.frame(&authority.unit).map_err(|_| bus_invalid())? {
                return Err(bus_invalid());
            }
            if manager::owner(connection, deadline).await? != owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            Ok(())
        })?;
        self.assert_current()
    }
    pub(super) fn retain_rollback_fence(&mut self) -> Result<()> {
        // A durable ConditionPathExists only prevents future starts. It cannot
        // stop a writer whose rollback StartUnit may already have succeeded.
        // Keep the same global lock while loading the reinstated conditions,
        // stopping every source writer and retaining actual empty cgroups.
        self.barrier.reinstate()?;
        self.profile.assert_current()?;
        self.boot.assert_current().map_err(bus_error)?;
        manager_alive(&self.manager_pidfd)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        let (owner, cgroups) = exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.manager_owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            reload_and_subscribe(connection, &owner, deadline).await?;
            let cgroups = stop_source_units(
                connection,
                &owner,
                self.profile.source_units(),
                &self.barrier.marker_path(),
                deadline,
            )
            .await?;
            if manager::owner(connection, deadline).await? != owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            Ok((owner, cgroups))
        })?;
        // A resumed service can have a new manager-selected cgroup inode. The
        // new observation is accepted only after its real StopUnit completion;
        // an observation error leaves the previous witness unusable and the
        // durable journal pending, never a claim of physical fencing.
        self.manager_owner = owner;
        self.cgroups = cgroups;
        self.assert_current()
    }
    pub(super) fn rollback_writers(&mut self) -> Result<()> {
        self.assert_early_rollback_origin()?;
        let result = self.resume_original_writers();
        rollback_result(result, || self.retain_rollback_fence())
    }
    fn resume_original_writers(&mut self) -> Result<()> {
        let original = self.original.as_ref().ok_or_else(invalid)?;
        self.barrier.release_for_early_rollback()?;
        let deadline = Instant::now() + Duration::from_secs(120);
        exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.manager_owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            manager::call(
                connection,
                &owner,
                MANAGER_PATH,
                MANAGER_INTERFACE,
                "Reload",
                &(),
                deadline,
            )
            .await?;
            manager::call(
                connection,
                &owner,
                MANAGER_PATH,
                MANAGER_INTERFACE,
                "Subscribe",
                &(),
                deadline,
            )
            .await?;
            for unit in self.profile.source_units() {
                let selected = original.frame(&unit.unit).map_err(|_| bus_invalid())?;
                let before =
                    observe_unit(connection, &owner, unit, &[], None, true, deadline).await?;
                if selected["activeState"] == "active" && selected["subState"] == "running" {
                    if before.quiescent() {
                        job(connection, &owner, &unit.unit, "StartUnit", deadline).await?;
                    }
                    let after =
                        observe_unit(connection, &owner, unit, &[], None, true, deadline).await?;
                    if after.active != "active"
                        || after.substate != "running"
                        || after.main_pid == 0
                        || after.control_pid != 0
                        || after.job != 0
                    {
                        return Err(bus_invalid());
                    }
                } else {
                    // Completed root oneshot and all originally inactive/failed
                    // units are observed exactly; they are never Stop/Started.
                    if before.frame(&unit.unit) != *selected {
                        return Err(bus_invalid());
                    }
                    ObservedCgroup::capture(&before.cgroup, &unit.unit)
                        .and_then(|c| c.assert_empty())
                        .map_err(|_| bus_invalid())?;
                }
            }
            let authority = &self.profile.authority_restart().source_unit;
            if observe_unit(connection, &owner, authority, &[], None, true, deadline)
                .await?
                .frame(&authority.unit)
                != *original.frame(&authority.unit).map_err(|_| bus_invalid())?
            {
                return Err(bus_invalid());
            }
            if manager::owner(connection, deadline).await? != owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            Ok(())
        })?;
        self.profile.assert_current()?;
        original.assert_current()?;
        original.assert_authority_untouched()?;
        manager_alive(&self.manager_pidfd)?;
        self.boot.assert_current().map_err(bus_error)
    }
    pub(crate) fn bootstrap_source_authority(&self) -> Result<()> {
        self.assert_current()?;
        switch_authority(self, AuthorityStage::Source)?;
        self.assert_current()
    }
    pub(crate) fn restart_target_authority(
        &self,
        prepared: &PreparedSchemaTargetRestartV2,
    ) -> Result<()> {
        self.assert_current()?;
        let restart = self.profile.authority_restart();
        if prepared.target_authority_configuration_hash()
            != restart.target_authority_configuration_hash
        {
            return Err(invalid());
        }
        // The independently pinned target command is selected by the profile;
        // the opaque signed finalization binds its canonical config domain.
        restart_target(self, prepared)?;
        self.assert_current()
    }
}

/// Both a failed restart and a failed durable completion require the same
/// physical re-fence. A failed Stop/observation is returned as unknown physical
/// state; a surviving marker never substitutes for a stopped writer.
pub(super) fn rollback_result<T>(
    result: Result<T>,
    retain_fence: impl FnOnce() -> Result<()>,
) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(cause) => {
            retain_fence()?;
            Err(cause)
        }
    }
}

async fn reload_and_subscribe(
    connection: &Connection,
    owner: &str,
    deadline: Instant,
) -> BusResult<()> {
    for method in ["Reload", "Subscribe"] {
        manager::call(
            connection,
            owner,
            MANAGER_PATH,
            MANAGER_INTERFACE,
            method,
            &(),
            deadline,
        )
        .await?;
    }
    Ok(())
}

fn source_maintenance_drop_in(unit: &SourceUnitV1) -> PathBuf {
    // Private fixture units exist only in a test binary; the installed profile
    // still accepts solely the four fixed production /etc source units.
    #[cfg(test)]
    if unit.unit.starts_with("hepta-schema-rollback-test-")
        && unit.fragment.path == PathBuf::from("/run/systemd/system").join(&unit.unit)
    {
        return PathBuf::from("/run/systemd/system")
            .join(format!("{}.d", unit.unit))
            .join(DROP_IN_NAME);
    }
    PathBuf::from("/etc/systemd/system")
        .join(format!("{}.d", unit.unit))
        .join(DROP_IN_NAME)
}

async fn stop_source_units(
    connection: &Connection,
    owner: &str,
    units: &[SourceUnitV1],
    marker: &Path,
    deadline: Instant,
) -> BusResult<Vec<(String, ObservedCgroup)>> {
    let mut observed = Vec::new();
    for unit in units {
        let drop_in = source_maintenance_drop_in(unit);
        let before = observe_unit(
            connection,
            owner,
            unit,
            std::slice::from_ref(&drop_in),
            Some(marker),
            true,
            deadline,
        )
        .await?;
        let cgroup =
            ObservedCgroup::capture(&before.cgroup, &unit.unit).map_err(|_| bus_invalid())?;
        // The completed fixed root oneshot is already empty and is preserved.
        if !before.quiescent_for(unit) {
            job(connection, owner, &unit.unit, "StopUnit", deadline).await?;
        } else if !before.quiescent() {
            cgroup.assert_empty().map_err(|_| bus_invalid())?;
        }
        let after = observe_unit(
            connection,
            owner,
            unit,
            std::slice::from_ref(&drop_in),
            Some(marker),
            true,
            deadline,
        )
        .await?;
        if !after.quiescent_for(unit) || (!after.cgroup.is_empty() && after.cgroup != before.cgroup)
        {
            return Err(bus_invalid());
        }
        cgroup.assert_empty().map_err(|_| bus_invalid())?;
        observed.push((unit.unit.clone(), cgroup));
    }
    Ok(observed)
}
fn manager_alive(pidfd: &OwnedFd) -> Result<()> {
    let mut descriptors = [PollFd::new(pidfd.as_fd(), PollFlags::POLLIN)];
    loop {
        match poll(&mut descriptors, PollTimeout::ZERO) {
            Ok(0) if descriptors[0].revents() == Some(PollFlags::empty()) => return Ok(()),
            Err(Errno::EINTR) => continue,
            _ => return Err(invalid()),
        }
    }
}

pub(super) fn hold_with_intent<'a>(
    profile: &'a ObservedInstalledSchemaProfileV1,
    operation: &SchemaOperationIdentityV1,
    journal: &mut super::journal::ExecutionJournalV1,
    now: i64,
) -> Result<HeldInstalledSchemaMaintenanceV1<'a>> {
    hold(profile, operation, Some((journal, now)))
}
fn hold<'a>(
    profile: &'a ObservedInstalledSchemaProfileV1,
    operation: &SchemaOperationIdentityV1,
    intent: Option<(&mut super::journal::ExecutionJournalV1, i64)>,
) -> Result<HeldInstalledSchemaMaintenanceV1<'a>> {
    profile.assert_current()?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let boot = manager::BootObservation::load().map_err(bus_error)?;
    let manager_pidfd = manager::installed_manager_pidfd(deadline).map_err(bus_error)?;
    manager_alive(&manager_pidfd)?;
    let mut original = None;
    let barrier = Barrier::acquire_with_preparation(profile, operation, |directory| {
        let Some((journal, now)) = intent else {
            return Ok(());
        };
        if journal.value()["version"] != 2 {
            return Ok(());
        }
        let pin = journal.value()["originalManagerFileSha256"]
            .as_str()
            .map(str::to_owned);
        let record = if let Some(pin) = pin {
            super::original::OriginalManagerV2::load(profile, operation, directory, &pin)?
        } else {
            let (owner, frames) = exchange(deadline, async |connection| {
                let owner = manager::owner(connection, deadline).await?;
                manager::principal(connection, &owner, deadline).await?;
                let mut frames = Vec::new();
                for unit in profile
                    .source_units()
                    .iter()
                    .chain(std::iter::once(&profile.authority_restart().source_unit))
                {
                    let observed =
                        observe_unit(connection, &owner, unit, &[], None, true, deadline).await?;
                    if super::installation::fixed_root_layout_oneshot(unit)
                        && observed.active == "active"
                        && observed.substate == "exited"
                    {
                        ObservedCgroup::capture(&observed.cgroup, &unit.unit)
                            .and_then(|c| c.assert_empty())
                            .map_err(|_| bus_invalid())?;
                    }
                    frames.push(observed.frame(&unit.unit));
                }
                frames.sort_by(|a, b| a["unit"].as_str().cmp(&b["unit"].as_str()));
                if manager::owner(connection, deadline).await? != owner {
                    return Err(bus_invalid());
                }
                manager::principal(connection, &owner, deadline).await?;
                Ok((owner, json!(frames)))
            })?;
            let record_path = directory.path.join(super::original::NAME);
            let record = match fs::symlink_metadata(&record_path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    super::original::OriginalManagerV2::capture(
                        profile,
                        operation,
                        directory,
                        boot.identity(),
                        &owner,
                        frames,
                    )?
                }
                Ok(_) => super::original::OriginalManagerV2::recover_unpinned(
                    profile,
                    operation,
                    directory,
                    boot.identity(),
                    &owner,
                    &frames,
                )?,
                Err(_) => return Err(invalid()),
            };
            journal.record_original_manager(&record.file_sha256()?, now)?;
            record
        };
        original = Some(record);
        Ok(())
    })?;
    let (manager_owner, cgroups) = exchange(deadline, async |connection| {
        let owner = manager::owner(connection, deadline).await?;
        manager::principal(connection, &owner, deadline).await?;
        // Persistent conditions must be loaded before any writer is stopped.
        reload_and_subscribe(connection, &owner, deadline).await?;
        let observed = stop_source_units(
            connection,
            &owner,
            profile.source_units(),
            &barrier.marker_path(),
            deadline,
        )
        .await?;
        if manager::owner(connection, deadline).await? != owner {
            return Err(bus_invalid());
        }
        manager::principal(connection, &owner, deadline).await?;
        Ok((owner, observed))
    })?;
    let result = HeldInstalledSchemaMaintenanceV1 {
        profile,
        barrier,
        boot,
        manager_pidfd,
        cgroups,
        manager_owner,
        original,
        operation: SchemaOperationIdentityV1 {
            runtime_root: operation.runtime_root.clone(),
            transition_id: operation.transition_id.clone(),
            plan_hash: operation.plan_hash.clone(),
            profile_sha256: operation.profile_sha256.clone(),
            barrier_root: operation.barrier_root.clone(),
        },
    };
    result.assert_current()?;
    Ok(result)
}

/// Reuse the bounded wire, root socket authentication, lexical executor and
/// descriptor-closed witness used by the existing authority manager observer.
fn exchange<T, F>(deadline: Instant, operation: F) -> Result<T>
where
    F: std::ops::AsyncFnOnce(&Connection) -> BusResult<T>,
{
    let stream = manager::open_installed_manager_socket(deadline).map_err(bus_error)?;
    let (socket, closed) =
        manager::wire::BoundedSocket::new(stream, deadline).map_err(|_| invalid())?;
    let outcome = async_io::block_on(async {
        let connection = manager::bounded(deadline, async {
            Builder::socket(socket)
                .auth_mechanism(AuthMechanism::External)
                .internal_executor(false)
                .max_queued(8)
                .build()
                .await
                .map_err(|_| bus_invalid())
        })
        .await?;
        let executor = connection.executor().clone();
        let outcome = futures_lite::future::race(
            async {
                loop {
                    executor.tick().await;
                }
            },
            manager::bounded(deadline, operation(&connection)),
        )
        .await;
        // Cancellation can drop a JobRemoved stream while zbus has queued its
        // RemoveMatch task. Interrupt the bounded wire, then drive the same
        // lexical executor until all such reader owners are destroyed. Cleanup
        // can never extend the wire's original RPC deadline or actuate a unit.
        closed.shutdown();
        let cleanup_deadline = Instant::now() + Duration::from_secs(5);
        let closing = manager::bounded(cleanup_deadline, async {
            let close = connection.close().await.map_err(|_| bus_invalid());
            while !executor.is_empty() {
                executor.tick().await;
            }
            close
        })
        .await;
        let outcome = match outcome {
            Ok(value) => {
                closing?;
                Ok(value)
            }
            Err(cause) => Err(cause),
        };
        drop(executor);
        outcome
    })
    .map_err(bus_error);
    if !closed.is_closed() {
        return Err(error(
            "autonomous_research_installed_schema_manager_reader_not_destroyed",
        ));
    }
    outcome
}

async fn observe_unit(
    connection: &Connection,
    owner: &str,
    expected: &SourceUnitV1,
    extra: &[PathBuf],
    marker: Option<&Path>,
    check_process: bool,
    deadline: Instant,
) -> BusResult<UnitObservation> {
    let message = manager::call(
        connection,
        owner,
        MANAGER_PATH,
        MANAGER_INTERFACE,
        "LoadUnit",
        &(expected.unit.as_str(),),
        deadline,
    )
    .await?;
    let path: OwnedObjectPath = message.body().deserialize().map_err(|_| bus_invalid())?;
    if path.as_str().len() > 4096 {
        return Err(bus_invalid());
    }
    macro_rules! unit {
        ($name:expr,$t:ty) => {
            manager::property::<$t>(
                connection,
                owner,
                path.as_str(),
                UNIT_INTERFACE,
                $name,
                deadline,
            )
            .await?
        };
    }
    macro_rules! service {
        ($name:expr,$t:ty) => {
            manager::property::<$t>(
                connection,
                owner,
                path.as_str(),
                SERVICE_INTERFACE,
                $name,
                deadline,
            )
            .await?
        };
    }
    let id = unit!("Id", String);
    let loaded = unit!("LoadState", String);
    let fragment = unit!("FragmentPath", String);
    let mut drop_ins = unit!("DropInPaths", Vec<String>);
    let need_reload = unit!("NeedDaemonReload", bool);
    if let Some(marker) = marker {
        let conditions = unit!("Conditions", Vec<(String, bool, bool, String, i32)>);
        let matches = conditions
            .iter()
            .filter(|v| v.0 == "ConditionPathExists" && v.3 == marker.display().to_string())
            .collect::<Vec<_>>();
        if matches.len() != 1 || matches[0].1 || !matches[0].2 {
            return Err(bus_invalid());
        }
    }
    let starts = service!("ExecStart", Vec<ExecStart>);
    let directory = service!("WorkingDirectory", String);
    let service_type = service!("Type", String);
    let kill_mode = service!("KillMode", String);
    let delegated = service!("Delegate", bool);
    let user = service!("User", String);
    let group = service!("Group", String);
    let configured_groups = service!("SupplementaryGroups", Vec<String>);
    let mut expected_drop_ins = expected
        .drop_ins
        .iter()
        .map(|pin| pin.path.display().to_string())
        .collect::<Vec<_>>();
    expected_drop_ins.extend(extra.iter().map(|path| path.display().to_string()));
    drop_ins.sort();
    expected_drop_ins.sort();
    if id != expected.unit
        || loaded != "loaded"
        || fragment != expected.fragment.path.to_str().ok_or_else(bus_invalid)?
        || drop_ins != expected_drop_ins
        || need_reload
        || starts.len() != 1
        || starts[0].0 != expected.executable.path.to_str().ok_or_else(bus_invalid)?
        || starts[0].1 != expected.argv
        || starts[0].2
        || directory
            != expected
                .working_directory
                .to_str()
                .ok_or_else(bus_invalid)?
        || service_type != expected.service_type
        || kill_mode != expected.kill_mode
        || delegated
        || !configured_principal_matches(&user, &group, &configured_groups, expected)
            .map_err(|_| bus_invalid())?
    {
        return Err(bus_invalid());
    }
    let active = unit!("ActiveState", String);
    let substate = unit!("SubState", String);
    let main_pid = service!("MainPID", u32);
    let control_pid = service!("ControlPID", u32);
    if main_pid != 0 && check_process {
        let uid = service!("UID", u32);
        let gid = service!("GID", u32);
        if uid != expected.uid || gid != expected.gid {
            return Err(bus_invalid());
        }
        process_matches(main_pid, expected).map_err(|_| bus_invalid())?;
    }
    let (job, _): (u32, OwnedObjectPath) = unit!("Job", (u32, OwnedObjectPath));
    let cgroup = service!("ControlGroup", String);
    Ok(UnitObservation {
        active,
        substate,
        main_pid,
        control_pid,
        job,
        cgroup,
    })
}

async fn job(
    connection: &Connection,
    owner: &str,
    unit: &str,
    method: &str,
    deadline: Instant,
) -> BusResult<()> {
    if !matches!(method, "StopUnit" | "StartUnit") {
        return Err(bus_invalid());
    }
    let mut signals = job_signals(connection, owner, unit, deadline).await?;
    let outcome = async {
        let response = manager::call(
            connection,
            owner,
            MANAGER_PATH,
            MANAGER_INTERFACE,
            method,
            &(unit, "replace"),
            deadline,
        )
        .await?;
        let selected: OwnedObjectPath = response.body().deserialize().map_err(|_| bus_invalid())?;
        for _ in 0..256 {
            let message = manager::bounded(deadline, async {
                signals
                    .next()
                    .await
                    .ok_or_else(bus_invalid)?
                    .map_err(|_| bus_invalid())
            })
            .await?;
            if message.header().sender().map(|v| v.as_str()) != Some(owner)
                || message.data().len() > 65536
                || !message.data().fds().is_empty()
            {
                return Err(bus_invalid());
            }
            let (_id, path, actual_unit, result): (u32, OwnedObjectPath, String, String) =
                message.body().deserialize().map_err(|_| bus_invalid())?;
            if actual_unit != unit {
                return Err(bus_invalid());
            }
            if path == selected {
                return if result == "done" {
                    Ok(())
                } else {
                    Err(bus_invalid())
                };
            }
        }
        Err(bus_invalid())
    }
    .await;
    // Take the rule before normal Drop can enqueue an unpolled task. The
    // enclosing exchange also drains cancellation cleanup after wire shutdown.
    manager::bounded(deadline, async {
        signals.async_drop().await;
        Ok(())
    })
    .await?;
    outcome
}

async fn job_signals(
    connection: &Connection,
    owner: &str,
    unit: &str,
    deadline: Instant,
) -> BusResult<MessageStream> {
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(owner)
        .map_err(|_| bus_invalid())?
        .path(MANAGER_PATH)
        .map_err(|_| bus_invalid())?
        .interface(MANAGER_INTERFACE)
        .map_err(|_| bus_invalid())?
        .member("JobRemoved")
        .map_err(|_| bus_invalid())?
        .arg(2, unit)
        .map_err(|_| bus_invalid())?
        .build();
    manager::bounded(deadline, async {
        MessageStream::for_match_rule(rule, connection, Some(8))
            .await
            .map_err(|_| bus_invalid())
    })
    .await
}

fn configured_principal_matches(
    user: &str,
    group: &str,
    configured: &[String],
    expected: &SourceUnitV1,
) -> Result<bool> {
    // Local, bounded root-owned passwd/group observations avoid unbounded NSS
    // resolution. These fixed installed profiles deliberately require a local
    // non-root service principal. Active processes are checked independently.
    let passwd = local_accounts(Path::new("/etc/passwd"))?;
    let groups = local_accounts(Path::new("/etc/group"))?;
    let users = passwd
        .lines()
        .map(|line| line.split(':').collect::<Vec<_>>())
        .filter(|v| v.len() == 7)
        .collect::<Vec<_>>();
    let user_records = users
        .iter()
        .filter(|v| {
            v[0] == user
                || (user.parse::<u32>().ok() == v[2].parse().ok() && user.parse::<u32>().is_ok())
        })
        .collect::<Vec<_>>();
    if user_records.len() != 1 || user_records[0][2].parse::<u32>().ok() != Some(expected.uid) {
        return Ok(false);
    }
    let username = user_records[0][0];
    let primary = user_records[0][3].parse::<u32>().map_err(|_| invalid())?;
    let entries = groups
        .lines()
        .map(|line| line.split(':').collect::<Vec<_>>())
        .filter(|v| v.len() == 4)
        .collect::<Vec<_>>();
    let resolve = |name: &str| -> Option<u32> {
        let found = entries
            .iter()
            .filter(|v| {
                v[0] == name
                    || (name.parse::<u32>().is_ok()
                        && name.parse::<u32>().ok() == v[2].parse().ok())
            })
            .collect::<Vec<_>>();
        if found.len() != 1 {
            None
        } else {
            found[0][2].parse().ok()
        }
    };
    if (if group.is_empty() {
        Some(primary)
    } else {
        resolve(group)
    }) != Some(expected.gid)
    {
        return Ok(false);
    }
    let mut supplementary = std::collections::BTreeSet::from([primary]);
    for entry in &entries {
        if entry[3].split(',').any(|v| v == username) {
            supplementary.insert(entry[2].parse::<u32>().map_err(|_| invalid())?);
        }
    }
    for name in configured {
        supplementary.insert(resolve(name).ok_or_else(invalid)?);
    }
    Ok(supplementary
        .into_iter()
        .eq(expected.supplementary_gids.iter().copied()))
}
fn local_accounts(path: &Path) -> Result<String> {
    use nix::{
        fcntl::{OFlag, open},
        sys::stat::Mode,
    };
    use std::{fs::File, io::Read, os::unix::fs::MetadataExt};
    let mut file = File::from(
        open(
            path,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    let before = file.metadata().map_err(|_| invalid())?;
    if !before.is_file()
        || before.uid() != 0
        || before.mode() & 0o022 != 0
        || before.len() > 1024 * 1024
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    let after = file.metadata().map_err(|_| invalid())?;
    let named = fs::symlink_metadata(path).map_err(|_| invalid())?;
    let identity = |m: &fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.uid(),
            m.gid(),
            m.mode(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    if bytes.len() as u64 != before.len()
        || !named.is_file()
        || named.is_symlink()
        || identity(&before) != identity(&after)
        || identity(&after) != identity(&named)
    {
        return Err(invalid());
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}
fn process_matches(pid: u32, expected: &SourceUnitV1) -> Result<()> {
    use std::{fs::File, io::Read, os::unix::fs::MetadataExt};
    // Cooperative root profile, actual procfs observation. The original PID 1
    // pidfd/boot and stopped cgroup are the continued physical witness.
    let path = PathBuf::from(format!("/proc/{pid}"));
    let directory = fs::symlink_metadata(&path).map_err(|_| invalid())?;
    let before = fs::read_link(path.join("exe")).map_err(|_| invalid())?;
    if before != expected.executable.path {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    File::open(path.join("cmdline"))
        .map_err(|_| invalid())?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 1024 * 1024 || bytes.last() != Some(&0) {
        return Err(invalid());
    }
    let args = bytes[..bytes.len() - 1]
        .split(|b| *b == 0)
        .map(|b| std::str::from_utf8(b).map(str::to_owned))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| invalid())?;
    let status = local_proc_status(&path.join("status"))?;
    let numbers = |name: &str| -> Result<Vec<u32>> {
        let values = status
            .lines()
            .filter_map(|v| v.strip_prefix(name))
            .collect::<Vec<_>>();
        if values.len() != 1 {
            return Err(invalid());
        }
        values[0]
            .split_whitespace()
            .map(|v| v.parse().map_err(|_| invalid()))
            .collect()
    };
    let uid = numbers("Uid:")?;
    let gid = numbers("Gid:")?;
    let mut groups = numbers("Groups:")?;
    groups.sort();
    let after = fs::symlink_metadata(&path).map_err(|_| invalid())?;
    if args != expected.argv
        || uid != vec![expected.uid; 4]
        || gid != vec![expected.gid; 4]
        || groups != expected.supplementary_gids
        || (directory.dev(), directory.ino()) != (after.dev(), after.ino())
        || fs::read_link(path.join("exe")).map_err(|_| invalid())? != before
    {
        return Err(invalid());
    }
    Ok(())
}
fn local_proc_status(path: &Path) -> Result<String> {
    use std::{fs::File, io::Read};
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| invalid())?
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 65536 {
        return Err(invalid());
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}

enum AuthorityStage<'a> {
    Source,
    Target(&'a PreparedSchemaTargetRestartV2),
}
fn native_source_unit(profile: &ObservedInstalledSchemaProfileV1) -> Result<SourceUnitV1> {
    let restart = profile.authority_restart();
    // These are declarative fields copied from the genuinely observed profile,
    // not another profile/capability constructor. The physical owner remains
    // borrowed and checks all original pins throughout this derived command.
    let mut source: SourceUnitV1 =
        serde_json::from_value(serde_json::to_value(&restart.target_unit).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    let configuration = restart
        .source_daemon_configuration
        .path
        .to_str()
        .ok_or_else(invalid)?;
    if !configuration
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
    {
        return Err(invalid());
    }
    source.argv = vec![
        source.executable.path.display().to_string(),
        "--configuration".into(),
        configuration.into(),
    ];
    Ok(source)
}
fn source_directive(unit: &SourceUnitV1) -> Vec<u8> {
    format!(
        "[Service]\nExecStart=\nExecStart={} --configuration {}\n",
        unit.argv[0], unit.argv[2]
    )
    .into_bytes()
}
fn verify_source_drop_in(path: &Path, unit: &SourceUnitV1) -> Result<()> {
    use crate::sqlite_mutation_coordinator::{authority::files::Snapshot, hash_bytes};
    let bytes = source_directive(unit);
    Snapshot::load(path, &hash_bytes(&bytes), 65536, CODE)?.assert_current()
}
fn restart_target(
    held: &HeldInstalledSchemaMaintenanceV1<'_>,
    prepared: &PreparedSchemaTargetRestartV2,
) -> Result<()> {
    switch_authority(held, AuthorityStage::Target(prepared))
}
fn switch_authority(
    held: &HeldInstalledSchemaMaintenanceV1<'_>,
    stage: AuthorityStage<'_>,
) -> Result<()> {
    use crate::sqlite_mutation_coordinator::{authority::files::Snapshot, hash_bytes};
    held.assert_current()?;
    let profile = held.profile.authority_restart();
    let source_unit = native_source_unit(held.profile)?;
    let source_path = PathBuf::from("/etc/systemd/system")
        .join(format!("{}.d", AUTHORITY_UNIT_V1))
        .join(SOURCE_DROP_IN);
    let target_path = source_path
        .parent()
        .ok_or_else(invalid)?
        .join(TARGET_DROP_IN);
    let (expected, name, bytes, pin) = match stage {
        AuthorityStage::Source => {
            // An intermediate bootstrap can never replace a selected target
            // command on recovery or roll a finalized authority back to source.
            if !matches!(fs::symlink_metadata(&target_path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
            {
                return Err(invalid());
            }
            let bytes = source_directive(&source_unit);
            let pin = hash_bytes(&bytes);
            (&source_unit, SOURCE_DROP_IN, bytes, pin)
        }
        AuthorityStage::Target(prepared) => {
            if prepared.target_authority_configuration_hash()
                != profile.target_authority_configuration_hash
            {
                return Err(invalid());
            }
            let staged = Snapshot::load(
                &profile.target_unit_drop_in.path,
                &profile.target_unit_drop_in.sha256,
                65536,
                CODE,
            )?;
            (
                &profile.target_unit,
                TARGET_DROP_IN,
                staged.bytes().to_vec(),
                profile.target_unit_drop_in.sha256.clone(),
            )
        }
    };
    // Stop barrier is durable before changing any loaded authority command.
    // A crash at the drop-in publication prefix cannot restart the old writer.
    let authority_barrier = AuthorityBarrier::acquire(&held.operation)?;
    let directory = super::barrier::ProtectedDirectory::open_or_create(
        source_path.parent().ok_or_else(invalid)?,
        true,
    )?;
    let selected = directory.path.join(name);
    match fs::symlink_metadata(&selected) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => directory.write_new(name, &bytes)?,
        Ok(_) => (),
        Err(_) => return Err(invalid()),
    }
    let installed = Snapshot::load(&selected, &pin, 65536, CODE)?;
    let mut extra = vec![
        selected.clone(),
        authority_barrier.drop_in_path().to_owned(),
    ];
    if name == TARGET_DROP_IN && fs::symlink_metadata(&source_path).is_ok() {
        verify_source_drop_in(&source_path, &source_unit)?;
        extra.push(source_path);
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    let original_cgroup = exchange(deadline, async |connection| {
        let owner = manager::owner(connection, deadline).await?;
        if owner != held.manager_owner {
            return Err(bus_invalid());
        }
        manager::principal(connection, &owner, deadline).await?;
        manager::call(
            connection,
            &owner,
            MANAGER_PATH,
            MANAGER_INTERFACE,
            "Reload",
            &(),
            deadline,
        )
        .await?;
        manager::call(
            connection,
            &owner,
            MANAGER_PATH,
            MANAGER_INTERFACE,
            "Subscribe",
            &(),
            deadline,
        )
        .await?;
        let before = observe_unit(
            connection,
            &owner,
            expected,
            &extra,
            Some(authority_barrier.marker_path()),
            false,
            deadline,
        )
        .await?;
        if before.job != 0 {
            return Err(bus_invalid());
        }
        // Already-started exact source/target is queried after lost replies.
        // The existing kernel then verifies its actual signed state/heads.
        if before.active == "active"
            && before.main_pid != 0
            && before.control_pid == 0
            && process_matches(before.main_pid, expected).is_ok()
        {
            return Ok(None);
        }
        if before.main_pid != 0 && process_matches(before.main_pid, &source_unit).is_err() {
            process_matches(before.main_pid, &profile.source_unit).map_err(|_| bus_invalid())?;
        }
        let cgroup = ObservedCgroup::capture(&before.cgroup, AUTHORITY_UNIT_V1)
            .map_err(|_| bus_invalid())?;
        if !before.quiescent() {
            job(connection, &owner, AUTHORITY_UNIT_V1, "StopUnit", deadline).await?;
        }
        let after = observe_unit(
            connection,
            &owner,
            expected,
            &extra,
            Some(authority_barrier.marker_path()),
            false,
            deadline,
        )
        .await?;
        if !after.quiescent() || (!after.cgroup.is_empty() && after.cgroup != before.cgroup) {
            return Err(bus_invalid());
        }
        cgroup.assert_empty().map_err(|_| bus_invalid())?;
        if manager::owner(connection, deadline).await? != owner {
            return Err(bus_invalid());
        }
        manager::principal(connection, &owner, deadline).await?;
        Ok(Some(cgroup))
    })?;
    if let Some(cgroup) = original_cgroup {
        let stopped = HeldStoppedInstalledAuthorityV1 {
            maintenance: held,
            cgroup,
            barrier: authority_barrier,
        };
        stopped.assert_current()?;
        match stage {
            AuthorityStage::Source => {
                super::authority_journal::migrate_stopped_installed_authority_source_journal_v1(
                    &stopped,
                )?
            }
            AuthorityStage::Target(prepared) => {
                super::authority_journal::migrate_stopped_installed_authority_journal_v1(
                    &stopped, prepared,
                )?
            }
        }
        stopped.assert_current()?;
        stopped.barrier.release_after_verified_publication()?;
        let deadline = Instant::now() + Duration::from_secs(120);
        exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != held.manager_owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            manager::call(
                connection,
                &owner,
                MANAGER_PATH,
                MANAGER_INTERFACE,
                "Subscribe",
                &(),
                deadline,
            )
            .await?;
            let before =
                observe_unit(connection, &owner, expected, &extra, None, false, deadline).await?;
            if before.job != 0 || !before.quiescent() {
                return Err(bus_invalid());
            }
            job(connection, &owner, AUTHORITY_UNIT_V1, "StartUnit", deadline).await?;
            let after =
                observe_unit(connection, &owner, expected, &extra, None, true, deadline).await?;
            if after.active != "active"
                || after.main_pid == 0
                || after.control_pid != 0
                || after.job != 0
            {
                return Err(bus_invalid());
            }
            if manager::owner(connection, deadline).await? != owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            Ok(())
        })?;
    } else {
        authority_barrier.release_after_verified_publication()?;
    }
    installed.assert_current()?;
    directory.assert_current()?;
    held.assert_current()
}

#[cfg(test)]
mod early_rollback_tests {
    use super::*;
    fn unit() -> SourceUnitV1 {
        let pin = crate::sqlite_mutation_coordinator::hash_bytes(b"test-profile-only");
        let file = |path: &str| super::super::installation::PinnedInstalledFileV1 {
            path: PathBuf::from(path),
            sha256: pin.clone(),
        };
        SourceUnitV1 {
            unit: "autonomous-submission-handoff-layout-provision.service".into(),
            fragment: file(
                "/etc/systemd/system/autonomous-submission-handoff-layout-provision.service",
            ),
            drop_ins: vec![],
            executable: file("/usr/bin/env"),
            argv: [
                "/usr/bin/env",
                "-i",
                "PATH=/usr/sbin:/usr/bin",
                "/usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision",
                "--runtime-root",
                "/var/lib/hepta-paper/runtime",
                "--receipt-path",
                "/run/hepta-paper-handoff-layout/autonomous-submission-handoff-layout.receipt.json",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            working_directory: PathBuf::new(),
            uid: 0,
            gid: 982,
            supplementary_gids: vec![0],
            service_type: "oneshot".into(),
            kill_mode: "control-group".into(),
            input_files: vec![file(
                "/usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision",
            )],
        }
    }
    #[test]
    fn fixed_completed_root_oneshot_requires_exact_contract_and_zero_processes() {
        let expected = unit();
        assert!(super::super::installation::fixed_root_layout_oneshot(
            &expected
        ));
        let mut observed = UnitObservation {
            active: "active".into(),
            substate: "exited".into(),
            main_pid: 0,
            control_pid: 0,
            job: 0,
            cgroup: String::new(),
        };
        assert!(observed.quiescent_for(&expected));
        assert!(!observed.quiescent());
        for field in 0..3 {
            observed.main_pid = 0;
            observed.control_pid = 0;
            observed.job = 0;
            match field {
                0 => observed.main_pid = 1,
                1 => observed.control_pid = 1,
                _ => observed.job = 1,
            };
            assert!(!observed.quiescent_for(&expected));
        }
        for change in 0..8 {
            let mut bad = unit();
            match change {
                0 => bad.unit = "hepta-paper-state-authority.service".into(),
                1 => bad.service_type = "simple".into(),
                2 => bad.kill_mode = "process".into(),
                3 => bad.argv[3] = "/usr/bin/sh".into(),
                4 => bad.supplementary_gids.push(5),
                5 => bad.gid = 0,
                6 => bad.input_files.clear(),
                _ => bad.working_directory = PathBuf::from("/tmp"),
            };
            assert!(!super::super::installation::fixed_root_layout_oneshot(&bad));
        }
    }
    #[test]
    fn synthetic_or_foreign_cgroups_cannot_prove_completed_root_oneshot() {
        for path in [
            "/",
            "/tmp/fixture",
            "/system.slice/foreign.service",
            "/system.slice/../autonomous-submission-handoff-layout-provision.service",
            "/system.slice/autonomous-submission-handoff-layout-provision.service/child",
        ] {
            assert!(
                ObservedCgroup::capture(
                    path,
                    "autonomous-submission-handoff-layout-provision.service"
                )
                .is_err()
            );
        }
    }
}

#[cfg(test)]
mod rollback_refence_tests;
