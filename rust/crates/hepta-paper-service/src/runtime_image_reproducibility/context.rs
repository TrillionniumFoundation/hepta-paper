use super::*;
use std::{collections::BTreeSet, fs, os::unix::fs::MetadataExt, path::Component};

fn relative(value: &Value) -> Result<&str> {
    let s = s(value);
    ensure(
        !s.is_empty()
            && s.len() <= 4096
            && !s.contains('\\')
            && Path::new(s)
                .components()
                .all(|p| matches!(p, Component::Normal(_)))
            && s.split('/').all(|p| !p.is_empty() && p != "." && p != ".."),
        "runtime_reproducibility_context_entry_outside_root",
    )?;
    Ok(s)
}
fn walk(
    root: &Path,
    dir: &Path,
    excluded: &BTreeSet<String>,
    records: &mut Vec<Value>,
    total: &mut u64,
) -> Result<()> {
    let mut paths = fs::read_dir(dir)?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    paths.sort();
    for p in paths {
        ensure(
            records.len() < 100_000,
            "runtime_reproducibility_context_resource_limit",
        )?;
        let rel = p
            .strip_prefix(root)
            .ok()
            .and_then(Path::to_str)
            .ok_or_else(|| Error("runtime_reproducibility_context_entry_outside_root".into()))?;
        ensure(
            Path::new(rel).components().count() <= 64,
            "runtime_reproducibility_context_resource_limit",
        )?;
        if excluded.contains(rel) {
            continue;
        }
        let st = fs::symlink_metadata(&p)?;
        let mode = st.mode() & 0o777;
        if st.is_dir() {
            records.push(json!({"path":format!("{rel}/"),"type":"directory","mode":mode}));
            walk(root, &p, excluded, records, total)?;
        } else if st.is_file() {
            let bytes = read_source(&p, 64 * 1024 * 1024)?;
            *total += bytes.len() as u64;
            ensure(
                *total <= 256 * 1024 * 1024,
                "runtime_reproducibility_context_resource_limit",
            )?;
            records.push(json!({"path":rel,"type":"file","mode":mode,"bytes":bytes.len(),"contentHash":digest(&bytes)}));
        } else {
            return Err("runtime_reproducibility_definition_file_invalid".into());
        }
    }
    Ok(())
}
/// Inspect all declared context bytes, including Dockerfile frontend, pinned base
/// images, transport exclusions, modes, and deterministic OCI build policy.
/// Contexts are bounded to 100,000 entries and 256 MiB, with regular-file leaves.
pub fn inspect_runtime_image_build_input_closure_v1(
    root: &Path,
    definition: &Value,
) -> Result<Value> {
    ensure(
        definition.is_object()
            && definition.as_object().is_some_and(|o| {
                o.keys().all(|k| {
                    [
                        "profile",
                        "contextPath",
                        "definitionPaths",
                        "image",
                        "imageDigest",
                        "definitionManifestHash",
                        "dockerfile",
                        "contextTransportMetadataPaths",
                    ]
                    .contains(&k.as_str())
                })
            })
            && PROFILES.contains(&s(&definition["profile"]))
            && sha(&definition["imageDigest"])
            && sha(&definition["definitionManifestHash"])
            && !s(&definition["image"]).is_empty(),
        "runtime_reproducibility_input_configuration_invalid",
    )?;
    let canonical_root = fs::canonicalize(root)?;
    ensure(
        canonical_root == root,
        "runtime_reproducibility_path_not_canonical",
    )?;
    let prefix = relative(&definition["contextPath"])?;
    let context = root.join(prefix);
    ensure(
        fs::canonicalize(&context)? == context && fs::metadata(&context)?.is_dir(),
        "runtime_reproducibility_canonical_context_required",
    )?;
    let paths = array(&definition["definitionPaths"]);
    ensure(
        !paths.is_empty() && paths.len() <= 100_000,
        "runtime_reproducibility_input_configuration_invalid",
    )?;
    let declared: Vec<_> = paths.iter().map(relative).collect::<Result<Vec<_>>>()?;
    let declared_set: BTreeSet<_> = declared.iter().copied().collect();
    ensure(
        declared_set.len() == declared.len(),
        "runtime_reproducibility_context_definition_not_exhaustive",
    )?;
    let excluded_raw = array(&definition["contextTransportMetadataPaths"]);
    let mut excluded = BTreeSet::new();
    for v in excluded_raw {
        let p = relative(v)?;
        ensure(
            p.ends_with("/.git")
                || p.ends_with("/.gitattributes")
                || p == ".git"
                || p == ".gitattributes",
            "runtime_reproducibility_context_transport_metadata_invalid",
        )?;
        ensure(
            excluded.insert(p.to_owned()) && !declared_set.contains(p),
            "runtime_reproducibility_context_transport_metadata_invalid",
        )?;
    }
    ensure(
        excluded_raw
            == excluded
                .iter()
                .map(|s| Value::String(s.clone()))
                .collect::<Vec<_>>(),
        "runtime_reproducibility_context_transport_metadata_invalid",
    )?;
    let ignore = context.join(".dockerignore");
    if excluded.is_empty() {
        ensure(
            !ignore.try_exists()?,
            "runtime_reproducibility_canonical_context_required",
        )?;
    } else {
        let expected = format!(
            "{}\n",
            excluded.iter().cloned().collect::<Vec<_>>().join("\n")
        );
        ensure(
            declared_set.contains(".dockerignore")
                && read_source(&ignore, 65536)? == expected.as_bytes(),
            "runtime_reproducibility_canonical_context_required",
        )?;
    }
    let mut records = Vec::new();
    walk(&context, &context, &excluded, &mut records, &mut 0)?;
    records.sort_by(|a, b| s(&a["path"]).cmp(s(&b["path"])));
    let actual: BTreeSet<_> = records
        .iter()
        .filter(|e| e["type"] != "directory")
        .map(|e| s(&e["path"]))
        .collect();
    ensure(
        actual == declared_set,
        "runtime_reproducibility_context_definition_not_exhaustive",
    )?;
    let legacy: Vec<_> = declared
        .iter()
        .map(|p| {
            let data = read_source(&context.join(p), 64 * 1024 * 1024)?;
            Ok(json!({"path":format!("{prefix}/{p}"),"sha256":digest(&data)}))
        })
        .collect::<Result<_>>()?;
    let definition_hash = hash("RuntimeImageBuildDefinitionManifest", &json!(legacy))?;
    ensure(
        definition["definitionManifestHash"] == definition_hash,
        "runtime_reproducibility_definition_manifest_drift",
    )?;
    let dockerfile = if definition["dockerfile"].is_null() {
        "Dockerfile"
    } else {
        relative(&definition["dockerfile"])?
    };
    let docker_bytes = read_source(&context.join(dockerfile), 1024 * 1024)?;
    let text = std::str::from_utf8(&docker_bytes)
        .map_err(|_| Error("runtime_reproducibility_dockerfile_invalid".into()))?;
    let frontend = text.lines().find_map(|l| {
        l.trim()
            .strip_prefix('#')
            .and_then(|l| l.trim().strip_prefix("syntax"))
            .and_then(|l| l.trim().strip_prefix('='))
            .map(str::trim)
    });
    ensure(
        frontend == Some(FRONTEND),
        "runtime_reproducibility_dockerfile_frontend_policy_drift",
    )?;
    let mut bases = Vec::new();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        if !words.next().is_some_and(|w| w.eq_ignore_ascii_case("FROM")) {
            continue;
        }
        let Some(image) = words.find(|w| !w.starts_with("--")) else {
            return Err("runtime_reproducibility_dockerfile_invalid".into());
        };
        let tail: Vec<_> = words.collect();
        ensure(
            tail.is_empty() || (tail.len() == 2 && tail[0].eq_ignore_ascii_case("AS")),
            "runtime_reproducibility_dockerfile_invalid",
        )?;
        if image.starts_with('$') {
            continue;
        }
        ensure(
            image
                .rsplit_once('@')
                .is_some_and(|(_, h)| sha(&h.to_ascii_lowercase().into())),
            "runtime_reproducibility_base_image_digest_required",
        )?;
        bases.push(image);
    }
    ensure(
        !bases.is_empty(),
        "runtime_reproducibility_base_image_digest_required",
    )?;
    let manifest = json!(records);
    let policy = tar_policy();
    let closure = seal(
        "RuntimeImageCanonicalBuildInputClosure",
        json!({"version":1,"kind":"RuntimeImageCanonicalBuildInputClosure","profile":definition["profile"],"image":definition["image"],"registeredImageDigest":definition["imageDigest"],"contextPath":prefix,"contextManifest":manifest,"contextManifestHash":hash("RuntimeImageCanonicalDockerContextManifest",&manifest)?,"contextTarMetadataPolicy":policy,"contextTarMetadataPolicyHash":hash("RuntimeImageCanonicalContextTarMetadataPolicy",&policy)?,"definitionManifestHash":definition_hash,"dockerfile":dockerfile,"dockerfileContentHash":digest(&docker_bytes),"dockerfileFrontend":FRONTEND,"dockerfileFrontendDigest":FRONTEND.split('@').nth(1),"baseImageReferences":bases,"platform":"linux/amd64","buildArgs":{},"sourceDateEpoch":SOURCE_DATE_EPOCH,"cachePolicy":"cache-disabled","networkPolicy":"externally-declared-build-network-only","outputFormat":"oci-layout-v1","ociExporter":exporter(),"reproducibleOciMetadataRequired":true}),
        "runtimeImageCanonicalBuildInputClosureHash",
    )?;
    ensure(
        contract::input_valid(&closure),
        "runtime_reproducibility_input_closure_invalid",
    )?;
    Ok(closure)
}
/// Always read the repository's current provenance; never accept a receipt's
/// previous commit/tree/content identity as the current source authority.
pub fn current_runtime_image_release_binding_v1(root: &Path) -> Result<Value> {
    let provenance = crate::operational_status::current_operational_code_provenance_v1(root)
        .map_err(|_| Error("runtime_reproducibility_code_provenance_invalid".into()))?;
    let mut release = json!({});
    for k in [
        "packageVersion",
        "commit",
        "commitTree",
        "repositoryContentHash",
        "worktreeStateHash",
    ] {
        release[k] = provenance[k].clone();
    }
    release["treeDirty"] = (provenance["treeDirty"] == true).into();
    Ok(
        json!({"codeProvenance":provenance,"codeProvenanceHash":hash("RuntimeImageReproducibilityCodeProvenance",&provenance)?,"releaseIdentityHash":hash("RuntimeImageReproducibilityReleaseIdentity",&release)?}),
    )
}
