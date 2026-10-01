//! Fixed ordinary Node observer data inputs. These are held and hash-bound
//! differential inputs; the empty R source archive remains unqualified.
use super::{Owner, SourceGraph, digest, error};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
};
pub(super) const ROOTS: &[&str] = &["runtime-images"];
const FILES: &[(&str, &str)] = &[
    (
        "runtime-images/python-gpu/Dockerfile",
        "sha256:1a0f880e18a779e7360d1d93f123a47e3506d3e2537dc7a0b2bc05839c8653e1",
    ),
    (
        "runtime-images/python-gpu/hepta-dataset-access-supervisor",
        "sha256:a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0",
    ),
    (
        "runtime-images/python-gpu/requirements.lock",
        "sha256:7b1c06908bc08105f9fdbc4bccb9729efd45cee2b6781d1d0041beaf59c7c62e",
    ),
    (
        "runtime-images/python-gpu/scientific-requirements.lock",
        "sha256:e71a0cd06560327bd3fbddb712f81007b6f1ed3a1e70a6667426c2dff44d9aeb",
    ),
    (
        "runtime-images/python-scientific/Dockerfile",
        "sha256:07c13543b0a09bcee8a4104d4bdc07a825f1fb5de40b3df49a2c1ec0ad88f092",
    ),
    (
        "runtime-images/python-scientific/hepta-dataset-access-supervisor",
        "sha256:a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0",
    ),
    (
        "runtime-images/python-scientific/requirements.lock",
        "sha256:e71a0cd06560327bd3fbddb712f81007b6f1ed3a1e70a6667426c2dff44d9aeb",
    ),
    (
        "runtime-images/r-scientific/.dockerignore",
        "sha256:cadb3516284556e0d2e09735f2c1fb5bfe0d780438433dacacd4127f33d02c1d",
    ),
    (
        "runtime-images/r-scientific/Dockerfile",
        "sha256:f54a8d2d6aeb7ac3eb46644be571ba18811a05689d441f4a3939dd52ce7461e0",
    ),
    (
        "runtime-images/r-scientific/hepta-dataset-access-supervisor",
        "sha256:a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0",
    ),
    (
        "runtime-images/r-scientific/normalize-installed.sh",
        "sha256:3019a1dc4368e3e84f05c7ec90d086a7cc691a05b84dc59b2c79b5909ec91899",
    ),
    (
        "runtime-images/r-scientific/packages.lock",
        "sha256:4f630709f8a9aba14d92f7c60d572877cfced2d2b67471d381ab9c52d0038740",
    ),
    (
        "runtime-images/r-scientific/renv.lock",
        "sha256:4ff5ef691272d3c1fa636fb887eef4b4ed4433234995893421ec17b204e5b388",
    ),
    (
        "runtime-images/r-scientific/restore-locked.R",
        "sha256:15618ffe5a2cfcfb6cfb6d64f9ccdcd9eaa394b2f7c550f4aeeab933255391b2",
    ),
    (
        "runtime-images/r-scientific/verify-locked.R",
        "sha256:82cb716120137ccdbbfac000dfa7f0364f73090b16739940f5a928902f0e4313",
    ),
];
pub(super) struct Assets {
    cas_path: PathBuf,
    cas_file: File,
    cas_metadata: Metadata,
    report: Value,
}
pub(super) fn validate_paths(paths: &BTreeSet<String>) -> Result<(), String> {
    let actual = paths
        .iter()
        .filter(|p| p.starts_with("runtime-images/"))
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected = FILES.iter().map(|(p, _)| *p).collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(error("policy_node_asset_namespace_invalid"));
    }
    Ok(())
}
fn empty(path: &std::path::Path) -> Result<(), String> {
    let mut entries = fs::read_dir(path).map_err(|_| error("policy_node_asset_cas_unsafe"))?;
    if entries.next().is_some() {
        return Err(error("policy_node_asset_cas_not_empty"));
    }
    Ok(())
}
impl Assets {
    pub(super) fn capture(owner: &mut Owner<'_>, graph: &mut SourceGraph) -> Result<Self, String> {
        owner.remaining()?;
        let cas_path = owner
            .request
            .source
            .workspace_root
            .join("runtime-images/r-scientific/source-cas");
        let named =
            fs::symlink_metadata(&cas_path).map_err(|_| error("policy_node_asset_cas_unsafe"))?;
        if !named.is_dir() || named.is_symlink() {
            return Err(error("policy_node_asset_cas_unsafe"));
        }
        let cas_file = OpenOptions::new()
            .read(true)
            .custom_flags(
                nix::libc::O_NOFOLLOW
                    | nix::libc::O_DIRECTORY
                    | nix::libc::O_NONBLOCK
                    | nix::libc::O_CLOEXEC,
            )
            .open(&cas_path)
            .map_err(|_| error("policy_node_asset_cas_unsafe"))?;
        let cas_metadata = cas_file
            .metadata()
            .map_err(|_| error("policy_node_asset_cas_unsafe"))?;
        if !super::super::same(&named, &cas_metadata) {
            return Err(error("policy_node_asset_cas_changed"));
        }
        empty(&cas_path)?;
        let mut files = Vec::new();
        let mut bytes = 0;
        for (path, sha) in FILES {
            let raw = graph.read_input(owner, path)?;
            if digest(&raw) != *sha {
                return Err(error("policy_node_asset_bytes_invalid"));
            }
            bytes += raw.len();
            files.push(json!({"path":path,"bytes":raw.len(),"sha256":sha}));
        }
        let result = Self {
            cas_path,
            cas_file,
            cas_metadata,
            report: json!({"version":1,"kind":"FixedRuntimeImageRegistryDataInputs","files":files,"fileCount":FILES.len(),"fileBytes":bytes,"sourceCasState":"actual_empty_no_manifest","rRuntimeArchiveQualification":false,"externalImageBuildOrDownloadPerformed":false,"productNodeImplementationClaimed":false}),
        };
        result.assert_current(owner)?;
        Ok(result)
    }
    pub(super) fn assert_current(&self, owner: &Owner<'_>) -> Result<(), String> {
        owner.remaining()?;
        let held = self
            .cas_file
            .metadata()
            .map_err(|_| error("policy_node_asset_cas_changed"))?;
        let named = fs::symlink_metadata(&self.cas_path)
            .map_err(|_| error("policy_node_asset_cas_changed"))?;
        if !super::super::same(&held, &self.cas_metadata)
            || !super::super::same(&named, &self.cas_metadata)
        {
            return Err(error("policy_node_asset_cas_changed"));
        }
        empty(&self.cas_path)
    }
    pub(super) fn report(&self) -> &Value {
        &self.report
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_data_namespace_is_exact_and_source_cas_never_silently_upgrades() {
        let mut paths = FILES
            .iter()
            .map(|(p, _)| (*p).to_owned())
            .collect::<BTreeSet<_>>();
        validate_paths(&paths).unwrap();
        paths.insert("runtime-images/r-scientific/source-cas/manifest.json".into());
        assert!(validate_paths(&paths).is_err());
        let mut suffix = [0; 16];
        getrandom::fill(&mut suffix).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-node-assets-test-{}", hex::encode(suffix)));
        fs::create_dir(&root).unwrap();
        empty(&root).unwrap();
        fs::write(root.join("manifest.json"), b"{}").unwrap();
        assert!(empty(&root).is_err());
        fs::remove_file(root.join("manifest.json")).unwrap();
        fs::remove_dir(&root).unwrap();
    }
}
