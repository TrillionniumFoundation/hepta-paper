//! Immutable, signed-hash-bound normalized preimages. Progress JSON is never
//! evidence of database contents; every recovery reloads the real source bytes.
use super::*;
use crate::state_database_inventory::schema_source::{
    SchemaSource, maintenance_lock::SchemaMaintenanceLock,
};
use nix::fcntl::{RenameFlags, renameat2};
use std::{collections::BTreeSet, fs, path::Path};

/// Exact read-only observation of the immutable installation preimages retained
/// by a finalized native transition. It creates no directory or database and
/// keeps every source descriptor alive until the successor plan is returned.
struct ObservedPreimageStaging {
    name: String,
    directory: publication::Directory,
    image: Option<(files::ObservedFile, String)>,
}
impl ObservedPreimageStaging {
    fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        let entries = fs::read_dir(&self.directory.path)
            .map_err(|_| error("autonomous_research_online_schema_transition_preimage_invalid"))?
            .map(|entry| {
                entry
                    .map_err(|cause| error(cause.to_string()))?
                    .file_name()
                    .into_string()
                    .map_err(|_| {
                        error("autonomous_research_online_schema_transition_preimage_invalid")
                    })
            })
            .collect::<Result<BTreeSet<_>>>()?;
        match &self.image {
            None => ensure(
                entries.is_empty(),
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?,
            Some((image, expected)) => {
                ensure(
                    entries == ["image".to_owned()].into_iter().collect(),
                    "autonomous_research_online_schema_transition_preimage_invalid",
                )?;
                ensure(
                    hash_bytes(&image.bytes(256 * 1024 * 1024)?) == *expected,
                    "autonomous_research_online_schema_transition_preimage_invalid",
                )?;
                image.assert_current()?;
            }
        }
        self.directory.assert_current()
    }
}

/// Exact read-only observation of the immutable installation preimages retained
/// by a finalized native transition. It creates no directory or database and
/// keeps every source/staging descriptor alive until the successor plan returns.
pub(crate) struct ObservedInstallationPreimages {
    directory: publication::Directory,
    sources: Vec<(SchemaSource, String)>,
    staging: Vec<ObservedPreimageStaging>,
    expected_names: BTreeSet<String>,
}
impl ObservedInstallationPreimages {
    fn staged_name(name: &str) -> bool {
        name.strip_prefix("staged-").is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    }
    pub(crate) fn observe_existing(runtime_root: &Path, plan: &Value) -> Result<Self> {
        let digest = text(plan, "planHash")?;
        ensure(
            crate::sqlite_mutation_coordinator::sha(&plan["planHash"]),
            "autonomous_research_online_schema_transition_installation_plan_invalid",
        )?;
        let suffix = digest.strip_prefix("sha256:").ok_or_else(|| {
            error("autonomous_research_online_schema_transition_installation_plan_invalid")
        })?;
        let path = runtime_root
            .join("autonomous-research/online-schema-transition")
            .join(format!("preimages-{suffix}"));
        let directory = publication::Directory::open_or_create(&path, false)?;
        let instances = plan["instances"].as_array().ok_or_else(|| {
            error("autonomous_research_online_schema_transition_installation_plan_invalid")
        })?;
        ensure(
            !instances.is_empty() && instances.len() <= 128,
            "autonomous_research_online_schema_transition_installation_plan_invalid",
        )?;
        let mut expected_names = BTreeSet::new();
        let mut expected_hashes = BTreeSet::new();
        let mut sources = Vec::with_capacity(instances.len());
        for row in instances {
            let name = InstallationPreimages::name(text(row, "databaseInstanceId")?);
            ensure(
                expected_names.insert(name.clone()),
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?;
            let expected = text(row, "expectedNormalizedSourceSha256")?.to_owned();
            ensure(
                expected_hashes.insert(expected.clone()),
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?;
            let source = SchemaSource::observe(
                &directory.path,
                Path::new(&name),
                text(row, "databaseRole")?,
            )?;
            source.installation_bytes(&expected)?;
            sources.push((source, expected));
        }
        let mut staging = Vec::new();
        let mut all_names = expected_names.clone();
        let entries = fs::read_dir(&directory.path)
            .map_err(|_| error("autonomous_research_online_schema_transition_preimage_invalid"))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| error("autonomous_research_online_schema_transition_preimage_invalid"))?;
        ensure(
            entries.len() <= expected_names.len() + 512,
            "autonomous_research_online_schema_transition_preimage_invalid",
        )?;
        for entry in entries {
            let name = entry.file_name().into_string().map_err(|_| {
                error("autonomous_research_online_schema_transition_preimage_invalid")
            })?;
            if expected_names.contains(&name) {
                continue;
            }
            ensure(
                Self::staged_name(&name) && all_names.insert(name.clone()),
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?;
            let stage = publication::Directory::open_or_create(&directory.path.join(&name), false)?;
            let children = fs::read_dir(&stage.path)
                .map_err(|_| {
                    error("autonomous_research_online_schema_transition_preimage_invalid")
                })?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| {
                    error("autonomous_research_online_schema_transition_preimage_invalid")
                })?;
            ensure(
                children.len() <= 1,
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?;
            let image = if let Some(child) = children.into_iter().next() {
                ensure(
                    child.file_name() == "image",
                    "autonomous_research_online_schema_transition_preimage_invalid",
                )?;
                let observed =
                    files::ObservedFile::open(&stage.path.join("image"), 256 * 1024 * 1024)?;
                let digest = hash_bytes(&observed.bytes(256 * 1024 * 1024)?);
                ensure(
                    expected_hashes.contains(&digest),
                    "autonomous_research_online_schema_transition_preimage_invalid",
                )?;
                Some((observed, digest))
            } else {
                None
            };
            let observed = ObservedPreimageStaging {
                name,
                directory: stage,
                image,
            };
            observed.assert_current()?;
            staging.push(observed);
        }
        let result = Self {
            directory,
            sources,
            staging,
            expected_names: all_names,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        let actual = fs::read_dir(&self.directory.path)
            .map_err(|_| error("autonomous_research_online_schema_transition_preimage_invalid"))?
            .map(|entry| {
                entry
                    .map_err(|cause| error(cause.to_string()))?
                    .file_name()
                    .into_string()
                    .map_err(|_| {
                        error("autonomous_research_online_schema_transition_preimage_invalid")
                    })
            })
            .collect::<Result<BTreeSet<_>>>()?;
        ensure(
            actual == self.expected_names,
            "autonomous_research_online_schema_transition_preimage_invalid",
        )?;
        for (source, expected) in &self.sources {
            source.installation_bytes(expected)?;
        }
        for stage in &self.staging {
            ensure(
                self.expected_names.contains(&stage.name),
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?;
            stage.assert_current()?;
        }
        self.directory.assert_current()
    }
}

pub(crate) struct InstallationPreimages<'a> {
    root: &'a SchemaMaintenanceLock,
    directory: publication::Directory,
}
impl<'a> InstallationPreimages<'a> {
    pub(crate) fn open(
        root: &'a SchemaMaintenanceLock,
        plan: &Value,
        create: bool,
    ) -> Result<Self> {
        root.assert_current()?;
        let digest = text(plan, "planHash")?;
        ensure(
            crate::sqlite_mutation_coordinator::sha(&plan["planHash"]),
            "autonomous_research_online_schema_transition_installation_plan_invalid",
        )?;
        let suffix = digest.strip_prefix("sha256:").ok_or_else(|| {
            error("autonomous_research_online_schema_transition_installation_plan_invalid")
        })?;
        let path = root
            .runtime_root()?
            .join("autonomous-research/online-schema-transition")
            .join(format!("preimages-{suffix}"));
        let directory = publication::Directory::open_or_create(&path, create)?;
        let result = Self { root, directory };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        self.root.assert_current()?;
        self.directory.assert_current()
    }
    fn name(id: &str) -> String {
        format!(
            "{}.preimage",
            hash_bytes(id.as_bytes()).trim_start_matches("sha256:")
        )
    }
    pub(crate) fn store(&self, row: &Value, bytes: &[u8]) -> Result<()> {
        self.assert_current()?;
        let expected = text(row, "expectedNormalizedSourceSha256")?;
        ensure(
            bytes.len() <= 256 * 1024 * 1024 && hash_bytes(bytes) == expected,
            "autonomous_research_online_schema_transition_preimage_invalid",
        )?;
        let name = Self::name(text(row, "databaseInstanceId")?);
        let path = self.directory.path.join(&name);
        if matches!(std::fs::symlink_metadata(&path),Err(e)if e.kind()==std::io::ErrorKind::NotFound)
        {
            // A crash while writing must not leave a partial file at the final
            // immutable name. Retain a private staging artifact; only publish
            // the completed, synced image through atomic no-replace rename.
            let staging = self
                .directory
                .child(&format!("staged-{}", publication::nonce()?))?;
            staging.write_new("image", bytes)?;
            let observed =
                files::ObservedFile::open(&staging.path.join("image"), 256 * 1024 * 1024)?;
            ensure(
                hash_bytes(&observed.bytes(256 * 1024 * 1024)?) == expected,
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?;
            observed.assert_current()?;
            self.assert_current()?;
            renameat2(
                &staging.held,
                "image",
                &self.directory.held,
                name.as_str(),
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|_| {
                error("autonomous_research_online_schema_transition_preimage_publication_conflict")
            })?;
            self.directory
                .held
                .sync_all()
                .map_err(|e| error(e.to_string()))?;
            staging.held.sync_all().map_err(|e| error(e.to_string()))?;
        }
        self.load(row)?.assert_current()?;
        self.assert_current()
    }
    pub(crate) fn load(&self, row: &Value) -> Result<SchemaSource> {
        self.assert_current()?;
        let name = Self::name(text(row, "databaseInstanceId")?);
        let source = SchemaSource::observe(
            &self.directory.path,
            Path::new(&name),
            text(row, "databaseRole")?,
        )?;
        source.installation_bytes(text(row, "expectedNormalizedSourceSha256")?)?;
        self.assert_current()?;
        Ok(source)
    }
}
