//! Normal read-only status composition over the original manifest/profile and
//! database inventory owners. No profile/client is exposed to the caller.
use super::*;
use crate::state_backup_authority::ProcessStateBackupAuthorityTransportV1;
use crate::state_database_inventory::{
    ObservedStateDatabaseStatusV1, StateDatabaseInventoryControlV1,
    observe_state_database_status_with_control_v1,
};
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

pub(crate) enum StateBackupStatusReadV1 {
    Help(&'static str),
    Observed(Box<StateBackupStatusObservationV1>),
}
pub(crate) struct StateBackupStatusObservationV1 {
    manifest: ManifestFile,
    configuration_files: Vec<super::super::files::ObservedFile>,
    backup: Option<PinnedStateBackupAuthorityV1<ProcessStateBackupAuthorityTransportV1>>,
    online: Option<PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>>,
    inventory: ObservedStateDatabaseStatusV1,
    control: StateDatabaseInventoryControlV1,
}
impl StateBackupStatusObservationV1 {
    pub(crate) fn report(&self) -> &Value {
        self.inventory.report()
    }
    pub(crate) fn check_control(&self) -> Result<()> {
        self.control.check()
    }
    pub(crate) fn check(&self) -> Result<()> {
        self.control.check()?;
        self.manifest.assert_current()?;
        for file in &self.configuration_files {
            self.control.check()?;
            file.assert_current()?;
        }
        if let Some(backup) = &self.backup {
            backup.assert_process_current_v1()?;
        }
        if let Some(online) = &self.online {
            online.assert_process_current_v1()?;
        }
        self.control.check()
    }
    pub(crate) fn finish(self) -> Result<Value> {
        self.check()?;
        let report = self.inventory.finish()?;
        self.manifest.assert_current()?;
        for file in &self.configuration_files {
            self.control.check()?;
            file.assert_current()?;
        }
        if let Some(backup) = &self.backup {
            backup.assert_process_current_v1()?;
        }
        if let Some(online) = &self.online {
            online.assert_process_current_v1()?;
        }
        self.control.check()?;
        Ok(report)
    }
}
fn original_grammar(argv: &[String]) -> std::result::Result<arguments::Arguments, String> {
    if argv.len() > 64
        || argv
            .iter()
            .try_fold(0usize, |n, v| n.checked_add(v.len()))
            .is_none_or(|n| n > 32 * 1024)
    {
        return Err("autonomous_research_state_backup_arguments_limit_exceeded".into());
    }
    // One shared token parser preserves the incumbent's error precedence.
    arguments::parse_original(argv)
}
pub(crate) fn ordinary_state_backup_status_help_v1(
    argv: &[String],
) -> std::result::Result<Option<&'static str>, String> {
    let args = original_grammar(argv)?;
    if args.help {
        return Ok(Some(arguments::USAGE));
    }
    if args.action != StateBackupActionV1::Status {
        return Err("autonomous_research_state_backup_ordinary_readonly_action_required".into());
    }
    Ok(None)
}
pub(crate) fn observe_ordinary_state_backup_status_v1(
    argv: &[String],
    context: &StateBackupCliContextV1,
    cancelled: &Arc<AtomicBool>,
    deadline: Instant,
) -> std::result::Result<StateBackupStatusReadV1, String> {
    let args = original_grammar(argv)?;
    if args.help {
        return Ok(StateBackupStatusReadV1::Help(arguments::USAGE));
    }
    if args.action != StateBackupActionV1::Status {
        return Err("autonomous_research_state_backup_ordinary_readonly_action_required".into());
    }
    let control = StateDatabaseInventoryControlV1::new(cancelled, deadline).map_err(|e| e.code)?;
    let observed = (|| -> Result<StateBackupStatusObservationV1> {
        let cwd = &context.working_directory;
        let workspace = crate::native_workspace::resolve_native_workspace_root_v1(
            cwd,
            &context.workspace_root,
            None,
        )
        .map_err(error)?;
        let runtime = if let Some(root) = args.runtime.as_ref().or_else(|| {
            context
                .environment
                .get("HEPTA_PAPER_RUNTIME_ROOT")
                .filter(|s| !s.is_empty())
        }) {
            arguments::resolve(cwd, Path::new(root))?
        } else {
            workspace
                .parent()
                .unwrap_or(Path::new("/"))
                .join("hepta-paper-runtime/native-runtime")
        };
        control.check()?;
        let manifest = ManifestFile::load_with_control(
            &workspace.join("paper-core/config/autonomous-research-state-databases.v1.json"),
            Some(control.clone()),
        )?;
        crate::state_backup_authority::manifest::assert_state_database_manifest_v1(
            &manifest.value,
        )?;
        let _writer = state_backup_writer_manifest_v1()?;
        let mut configuration_files = Vec::new();
        let backup = if let Some(path) = &args.backup_configuration {
            let path = arguments::resolve(cwd, Path::new(path))?;
            let (file, pin, _) = inputs::configuration_with_control(
                &path,
                "autonomous_research_state_backup_authority_process_configuration_invalid",
                Some(control.clone()),
            )?;
            let authority = PinnedStateBackupAuthorityV1::load_process_with_control(
                &path,
                &pin,
                Some(control.clone()),
            )?;
            configuration_files.push(file);
            Some(authority)
        } else {
            None
        };
        let online = if let Some(path) = &args.online_configuration {
            let path = arguments::resolve(cwd, Path::new(path))?;
            let (file, pin, document) = inputs::configuration_with_control(
                &path,
                "autonomous_research_online_mutation_authority_process_configuration_invalid",
                Some(control.clone()),
            )?;
            let transport = ProcessMutationAuthorityTransportV1::load_with_control(
                &path,
                &pin,
                Some(control.clone()),
            )?;
            let authority = PinnedMutationAuthorityV1::load_with_control(
                Path::new(text(&document, "authorityConfigurationPath")?),
                text(&document, "authorityConfigurationSha256")?,
                transport,
                Some(control.clone()),
            )?;
            configuration_files.push(file);
            Some(authority)
        } else {
            None
        };
        control.check()?;
        manifest.assert_current()?;
        for file in &configuration_files {
            file.assert_current()?;
        }
        let inventory = observe_state_database_status_with_control_v1(
            &runtime,
            &manifest.value,
            control.clone(),
        )?;
        let result = StateBackupStatusObservationV1 {
            manifest,
            configuration_files,
            backup,
            online,
            inventory,
            control: control.clone(),
        };
        result.check()?;
        Ok(result)
    })()
    .map_err(|e| e.code)?;
    Ok(StateBackupStatusReadV1::Observed(Box::new(observed)))
}
