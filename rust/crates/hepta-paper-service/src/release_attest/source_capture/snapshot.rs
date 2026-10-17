//! Exact incumbent WorkspaceReleaseStateSnapshot v2 insertion-order hash.
use super::*;
use crate::{operational_status::Ordered, release_state::inspect_release_state_v1};
use hepta_legacy_compatibility::ProductionCollationV1;

const DOCUMENTS: &[(&str, &str)] = &[
    ("packageJson", "package.json"),
    ("packageLock", "package-lock.json"),
    ("currentStatus", "paper-core/docs/CURRENT_STATUS.md"),
    ("releaseDocument", "RELEASE.md"),
    ("changelog", "CHANGELOG.md"),
];
pub(super) struct Snapshot {
    pub value: Value,
    documents: Vec<PinnedBytes>,
}
impl Snapshot {
    pub fn assert_current(&self) -> Result<()> {
        for document in &self.documents {
            document.assert_current()?;
        }
        Ok(())
    }
}
fn scalar(value: Value) -> Ordered {
    Ordered::Scalar(value)
}
fn list(value: &Value) -> Result<Ordered> {
    value
        .as_array()
        .map(|v| Ordered::Array(v.iter().cloned().map(scalar).collect()))
        .ok_or_else(|| error("snapshot_contract_invalid"))
}
fn ordered_state(value: &Value) -> Result<Ordered> {
    let mut fields = Vec::new();
    for name in [
        "ok",
        "kind",
        "contractVersion",
        "version",
        "state",
        "documentationProfile",
        "errors",
    ] {
        let value = value
            .get(name)
            .ok_or_else(|| error("snapshot_contract_invalid"))?;
        fields.push((
            name.into(),
            if name == "errors" {
                list(value)?
            } else {
                scalar(value.clone())
            },
        ));
    }
    Ok(Ordered::Object(fields))
}
fn tags(owner: &Owner<'_>, arguments: &[&str]) -> Result<Vec<String>> {
    let bytes = owner.query(&owner.request.workspace_root, arguments, None)?;
    let mut values = std::str::from_utf8(&bytes)
        .map_err(|_| error("tags_invalid"))?
        .lines()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let collation = ProductionCollationV1::load().map_err(|_| error("collation_unavailable"))?;
    values.sort_by(|a, b| collation.compare(a, b));
    Ok(values)
}
pub(super) fn capture(owner: &mut Owner<'_>) -> Result<Snapshot> {
    let mut documents = Vec::new();
    let mut request = json!({});
    let mut hashes = Vec::new();
    for (name, relative) in DOCUMENTS {
        let file = owner.read_file(
            &owner.request.workspace_root.join(relative),
            16 * 1024 * 1024,
        )?;
        request[*name] = if *name == "packageJson" || *name == "packageLock" {
            serde_json::from_slice(&file.bytes).map_err(|_| error("package_document_invalid"))?
        } else {
            Value::String(
                String::from_utf8(file.bytes.clone())
                    .map_err(|_| error("document_utf8_invalid"))?,
            )
        };
        hashes.push((
            name.to_string(),
            Ordered::Object(vec![
                ("path".into(), scalar(json!(relative))),
                ("sha256".into(), scalar(json!(hash(&file.bytes)))),
            ]),
        ));
        documents.push(file);
    }
    request["headTags"] = json!(tags(owner, &["tag", "--points-at", "HEAD"])?);
    request["allTags"] = json!(tags(owner, &["tag", "--list"])?);
    let state = inspect_release_state_v1(&request).map_err(|_| error("release_state_invalid"))?;
    let status = if state["ok"] == true {
        format!(
            "workspace_release_state_{}",
            state["state"]
                .as_str()
                .ok_or_else(|| error("release_state_invalid"))?
        )
    } else {
        "workspace_release_state_blocked".into()
    };
    let ordered = Ordered::Object(vec![
        ("version".into(), scalar(json!(2))),
        (
            "kind".into(),
            scalar(json!("WorkspaceReleaseStateSnapshot")),
        ),
        ("status".into(), scalar(json!(status))),
        (
            "headCommit".into(),
            scalar(json!(owner.request.expected_commit)),
        ),
        ("headTags".into(), list(&request["headTags"])?),
        ("allTags".into(), list(&request["allTags"])?),
        ("documentHashes".into(), Ordered::Object(hashes)),
        ("releaseState".into(), ordered_state(&state)?),
    ]);
    let bytes = ordered
        .encode(false)
        .map_err(|_| error("snapshot_encoding_failed"))?;
    let mut value = ordered.value();
    value["workspaceReleaseStateSnapshotHash"] = json!(hash(bytes.as_bytes()));
    let snapshot = Snapshot { value, documents };
    snapshot.assert_current()?;
    owner.assert_current()?;
    Ok(snapshot)
}
