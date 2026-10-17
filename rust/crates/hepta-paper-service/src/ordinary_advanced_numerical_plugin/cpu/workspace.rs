//! Source-member copy through the existing bounded snapshot and private Directory.
use super::super::*;
use crate::{
    native_research_manuscript::NativeResearchReadContextV1,
    native_research_source::{
        NativeResearchSourceSnapshotObservationV1, NativeResearchSourceSnapshotRequestV1,
        inspect_native_research_source_snapshot_with_context_v1,
    },
    state_recoverability::publication::{Directory, LocalReportDirectoryV1},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
};

pub(super) struct CpuWorkspace<'a> {
    source: NativeResearchSourceSnapshotObservationV1<'a>,
    allowed_output: LocalReportDirectoryV1,
    work_observation: NativeResearchSourceSnapshotObservationV1<'a>,
    pub sandbox: Directory,
    pub work: Directory,
    pub output: Directory,
    pub runtime: Directory,
    pub runtime_copy: PathBuf,
    pub runtime_path: PathBuf,
    pub executable_hash: String,
    pub c: &'a AtomicBool,
    pub d: Instant,
}
fn path_string(value: &Value) -> Result<&str, String> {
    value
        .as_str()
        .ok_or_else(|| "advanced_numerical_plugin_copy_input_invalid".into())
}
fn new_directory(
    parent: &Directory,
    name: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<Directory, String> {
    check(c, d)?;
    let result = parent.child(name).map_err(|e| e.to_string())?;
    check(c, d)?;
    result.assert_current().map_err(|e| e.to_string())?;
    Ok(result)
}
fn copy_file(
    directory: &Directory,
    name: &str,
    bytes: &[u8],
    mode: u32,
    c: &AtomicBool,
    d: Instant,
) -> Result<(), String> {
    check(c, d)?;
    directory
        .write_new_observed_mode_v1(name, bytes, mode)
        .map_err(|e| e.to_string())?;
    check(c, d)?;
    directory.assert_current().map_err(|e| e.to_string())
}
impl<'a> CpuWorkspace<'a> {
    pub(super) fn prepare(
        plugin_root: &Path,
        output_root: LocalReportDirectoryV1,
        descriptor: &Value,
        inputs: &mut StatusInputs<'a>,
        c: &'a AtomicBool,
        d: Instant,
    ) -> Result<Self, String> {
        inputs.require_control(c, d)?;
        if plugin_root.starts_with(&output_root.path) || output_root.path.starts_with(plugin_root) {
            return Err("advanced_numerical_plugin_separate_output_root_required".into());
        }
        let mut ctx = NativeResearchReadContextV1::new(c, d);
        let mut source = inspect_native_research_source_snapshot_with_context_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: plugin_root.to_owned(),
            },
            &mut ctx,
        )?;
        let snapshot = &source.snapshot()["workspaceSnapshot"];
        if snapshot["merkleHash"] != descriptor["sourceIdentity"]["merkleHash"]
            || snapshot["manifestHash"] != descriptor["sourceIdentity"]["workspaceManifestHash"]
        {
            return Err("advanced_numerical_plugin_source_identity_mismatch".into());
        }
        let files = snapshot["fileRecords"]
            .as_array()
            .ok_or("advanced_numerical_plugin_copy_input_invalid")?;
        let dirs = snapshot["directoryRecords"]
            .as_array()
            .ok_or("advanced_numerical_plugin_copy_input_invalid")?;
        // The existing member reader permits 129 reads. These are explicit
        // native-run limits; arbitrary 4096-file source execution is unaccepted.
        if files.len() > 129
            || dirs.len() > 128
            || files
                .iter()
                .any(|f| !matches!(f["mode"].as_u64(), Some(0o644 | 0o664 | 0o755)))
            || dirs.iter().any(|f| f["mode"] != 0o755)
        {
            return Err("advanced_numerical_plugin_copy_mode_or_count_domain_unaccepted".into());
        }
        let records = files.clone();
        let mut directory_records = dirs.clone();
        // Both bounded arrays are metadata from the opaque observed snapshot.
        directory_records.sort_by_key(|v| v["path"].as_str().map_or(0, |s| s.split('/').count()));
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| "advanced_numerical_plugin_randomness_unavailable")?;
        check(c, d)?;
        let sandbox = output_root
            .private_staging_child_v1(&format!(".hepta-native-numerical-{}", hex::encode(random)))
            .map_err(|e| e.to_string())?;
        check(c, d)?;
        let work = new_directory(&sandbox, "work", c, d)?;
        let output = new_directory(&sandbox, "output", c, d)?;
        let runtime = new_directory(&sandbox, "runtime", c, d)?;
        let mut directories = BTreeMap::new();
        for record in directory_records {
            check(c, d)?;
            let name = path_string(&record["path"])?;
            let selected = Path::new(name);
            let parent = selected
                .parent()
                .ok_or("advanced_numerical_plugin_copy_input_invalid")?;
            let owner = if parent.as_os_str().is_empty() {
                &work
            } else {
                directories
                    .get(parent)
                    .ok_or("advanced_numerical_plugin_copy_input_invalid")?
            };
            let leaf = selected
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("advanced_numerical_plugin_copy_input_invalid")?;
            let directory = new_directory(owner, leaf, c, d)?;
            directory
                .held
                .set_permissions(fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
            check(c, d)?;
            directory.assert_current().map_err(|e| e.to_string())?;
            if directory.held.metadata().map_err(|e| e.to_string())?.mode() & 0o7777 != 0o755 {
                return Err("advanced_numerical_plugin_copy_mode_invalid".into());
            }
            directories.insert(selected.to_owned(), directory);
        }
        for record in records {
            check(c, d)?;
            let name = path_string(&record["path"])?;
            let selected = Path::new(name);
            let bytes = source.listed_member_bytes_v1(selected, 4 * 1024 * 1024)?;
            let parent = selected
                .parent()
                .ok_or("advanced_numerical_plugin_copy_input_invalid")?;
            let owner = if parent.as_os_str().is_empty() {
                &work
            } else {
                directories
                    .get(parent)
                    .ok_or("advanced_numerical_plugin_copy_input_invalid")?
            };
            copy_file(
                owner,
                selected
                    .file_name()
                    .and_then(|v| v.to_str())
                    .ok_or("advanced_numerical_plugin_copy_input_invalid")?,
                &bytes,
                u32::try_from(
                    record["mode"]
                        .as_u64()
                        .ok_or("advanced_numerical_plugin_copy_input_invalid")?,
                )
                .map_err(|_| "advanced_numerical_plugin_copy_input_invalid")?,
                c,
                d,
            )?;
        }
        let work_observation = inspect_native_research_source_snapshot_with_context_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: work.path.clone(),
            },
            &mut ctx,
        )?;
        if source.snapshot()["workspaceSnapshot"]
            != work_observation.snapshot()["workspaceSnapshot"]
        {
            return Err("advanced_numerical_plugin_work_copy_identity_mismatch".into());
        }
        let runtime_path = sandbox::executable(
            inputs,
            path_string(&descriptor["runtime"]["executable"])?,
            c,
            d,
        )?
        .ok_or("advanced_numerical_plugin_runtime_identity_mismatch")?;
        let info = inputs
            .probe(&runtime_path)?
            .ok_or("advanced_numerical_plugin_runtime_identity_mismatch")?;
        if info.directory
            || info.link_count != 1
            || info.mode & 0o022 != 0
            || info.mode & 0o111 == 0
        {
            return Err("advanced_numerical_plugin_runtime_identity_mismatch".into());
        }
        let bytes = inputs.document(&runtime_path, 16 * 1024 * 1024)?;
        let executable_hash = format!("sha256:{:x}", Sha256::digest(&bytes));
        if descriptor["runtime"]["executableHash"] != executable_hash {
            return Err("advanced_numerical_plugin_runtime_identity_mismatch".into());
        }
        let leaf = runtime_path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("advanced_numerical_plugin_runtime_identity_mismatch")?;
        copy_file(&runtime, leaf, &bytes, 0o755, c, d)?;
        let runtime_copy = runtime.path.join(leaf);
        inputs.archive(&runtime_copy, 16 * 1024 * 1024)?;
        source.verify_unchanged()?;
        work_observation.verify_unchanged()?;
        inputs.assert_current()?;
        Ok(Self {
            source,
            allowed_output: output_root,
            work_observation,
            sandbox,
            work,
            output,
            runtime,
            runtime_copy,
            runtime_path,
            executable_hash,
            c,
            d,
        })
    }
    pub(super) fn source_snapshot(&self) -> &Value {
        &self.source.snapshot()["workspaceSnapshot"]
    }
    pub(super) fn work_snapshot(&self) -> &Value {
        &self.work_observation.snapshot()["workspaceSnapshot"]
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        check(self.c, self.d)?;
        self.allowed_output
            .assert_current()
            .map_err(|e| e.to_string())?;
        self.source.verify_unchanged()?;
        self.work_observation.verify_unchanged()?;
        for directory in [&self.sandbox, &self.work, &self.output, &self.runtime] {
            directory.assert_current().map_err(|e| e.to_string())?;
        }
        check(self.c, self.d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hepta_codex_runtime::{
        BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
        run_bounded_process_capturing_stdout_with_cancellation,
    };
    use std::{ffi::OsString, time::Duration};
    #[test]
    fn observed_group_source_mode_matches_original_copy_and_world_write_refuses() {
        let c = AtomicBool::new(false);
        let d = Instant::now() + Duration::from_secs(120);
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("hepta-cpu-mode-{}", hex::encode(random)));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let src = root.join("source");
        let output = root.join("output");
        fs::create_dir(&src).unwrap();
        fs::create_dir(&output).unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o775)).unwrap();
        fs::set_permissions(&output, fs::Permissions::from_mode(0o775)).unwrap();
        let member = src.join("plugin.py");
        fs::write(&member, b"print('observed member')\n").unwrap();
        fs::set_permissions(&member, fs::Permissions::from_mode(0o664)).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let node = PathBuf::from(std::env::var("HEPTA_TEST_NODE").unwrap());
        let code = r#"import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';const [repo,source,target]=process.argv.slice(1);const {inspectWorkspaceExecutionSnapshot}=await import(pathToFileURL(path.join(repo,'paper-adapters/runtime/execution-snapshot.mjs')));const before=inspectWorkspaceExecutionSnapshot(source);fs.cpSync(source,target,{recursive:true,dereference:false});const after=inspectWorkspaceExecutionSnapshot(target);process.stdout.write(JSON.stringify({before,after,mode:fs.statSync(path.join(target,'plugin.py')).mode&0o777}));"#;
        let environment =
            EnvironmentPolicyV1::new("cpu-source-mode-original-copy-v1", ["PATH"], ["PATH"])
                .unwrap()
                .build(
                    std::iter::empty::<(OsString, OsString)>(),
                    &BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                )
                .unwrap();
        let actual = run_bounded_process_capturing_stdout_with_cancellation(
            &BoundedProcessRequestV1 {
                executable: node,
                arguments: vec![
                    "--input-type=module".into(),
                    "-e".into(),
                    code.into(),
                    repo.into_os_string(),
                    src.clone().into_os_string(),
                    root.join("node-copy").into_os_string(),
                ],
                working_directory: root.clone(),
                environment,
                stdin: None,
            },
            ProcessLimitsV1 {
                timeout_ms: 30_000,
                maximum_stdout_bytes: 1024 * 1024,
                maximum_stderr_bytes: 128 * 1024,
                maximum_tail_bytes: 128 * 1024,
                ..Default::default()
            },
            &c,
        )
        .unwrap();
        assert_eq!(
            actual.process.termination_reason,
            ProcessTerminationReason::Exited
        );
        assert_eq!(
            actual.process.exit_code,
            Some(0),
            "{}",
            String::from_utf8_lossy(&actual.process.stderr_tail)
        );
        assert!(actual.process.process_group_cleanup_verified);
        let original: Value = serde_json::from_slice(&actual.stdout).unwrap();
        assert_eq!(original["mode"], 0o664);
        assert_eq!(original["before"]["blockers"], serde_json::json!([]));
        assert_eq!(
            original["before"]["merkleHash"],
            original["after"]["merkleHash"]
        );
        assert_eq!(
            original["before"]["manifestHash"],
            original["after"]["manifestHash"]
        );
        let python = Path::new("/usr/bin/python3.12");
        let python_hash = format!("sha256:{:x}", Sha256::digest(fs::read(python).unwrap()));
        let mut ctx = NativeResearchReadContextV1::new(&c, d);
        let snapshot = inspect_native_research_source_snapshot_with_context_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: src.clone(),
            },
            &mut ctx,
        )
        .unwrap();
        let values = &snapshot.snapshot()["workspaceSnapshot"];
        assert_eq!(values["merkleHash"], original["before"]["merkleHash"]);
        assert_eq!(values["manifestHash"], original["before"]["manifestHash"]);
        let descriptor = serde_json::json!({"sourceIdentity":{"merkleHash":values["merkleHash"],"workspaceManifestHash":values["manifestHash"]},"runtime":{"executable":"/usr/bin/python3.12","executableHash":python_hash}});
        let mut inputs = StatusInputs::new(&c, d).unwrap();
        let workspace = CpuWorkspace::prepare(
            &src,
            LocalReportDirectoryV1::open_or_create(&output, false).unwrap(),
            &descriptor,
            &mut inputs,
            &c,
            d,
        )
        .unwrap();
        assert_eq!(
            workspace.work_snapshot()["merkleHash"],
            original["after"]["merkleHash"]
        );
        assert_eq!(
            workspace.work_snapshot()["manifestHash"],
            original["after"]["manifestHash"]
        );
        assert_eq!(
            fs::metadata(workspace.work.path.join("plugin.py"))
                .unwrap()
                .mode()
                & 0o777,
            0o664
        );
        assert_eq!(
            workspace.sandbox.held.metadata().unwrap().mode() & 0o777,
            0o700
        );
        workspace.assert_current().unwrap();
        assert_eq!(fs::metadata(&member).unwrap().mode() & 0o777, 0o664);
        drop(workspace);
        drop(snapshot);
        drop(inputs);
        fs::set_permissions(&member, fs::Permissions::from_mode(0o666)).unwrap();
        let mut ctx = NativeResearchReadContextV1::new(&c, d);
        let snapshot = inspect_native_research_source_snapshot_with_context_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: src.clone(),
            },
            &mut ctx,
        )
        .unwrap();
        let values = &snapshot.snapshot()["workspaceSnapshot"];
        let descriptor = serde_json::json!({"sourceIdentity":{"merkleHash":values["merkleHash"],"workspaceManifestHash":values["manifestHash"]},"runtime":{"executable":"/usr/bin/python3.12","executableHash":python_hash}});
        let entries_before = fs::read_dir(&output).unwrap().count();
        let mut inputs = StatusInputs::new(&c, d).unwrap();
        let refused = CpuWorkspace::prepare(
            &src,
            LocalReportDirectoryV1::open_or_create(&output, false).unwrap(),
            &descriptor,
            &mut inputs,
            &c,
            d,
        );
        assert!(
            matches!(refused,Err(e) if e=="advanced_numerical_plugin_copy_mode_or_count_domain_unaccepted")
        );
        assert_eq!(fs::read_dir(&output).unwrap().count(), entries_before);
        fs::remove_dir_all(&root).unwrap();
    }
}
