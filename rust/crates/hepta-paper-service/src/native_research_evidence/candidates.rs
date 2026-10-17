//! Candidate data derived from the actual evidence-reader record shape.
use super::*;
/// Pure candidate construction. A caller field is never a verified receipt or
/// academic authority; the held artifact verifier must compute those separately.
pub fn build_native_evidence_verification_candidates_v1(
    root: &Path,
    source_root: Option<&Path>,
    structured: &Value,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<Value>, String> {
    check(c)?;
    if Instant::now() >= deadline
        || !root.is_absolute()
        || root.as_os_str().len() > 4096
        || source_root.is_some_and(|p| !p.is_absolute() || p.as_os_str().len() > 4096)
    {
        return Err(refused());
    }
    values_budget(std::iter::once(structured))?;
    let normalized_structured = json_boundary(structured);
    let structured = &normalized_structured;
    let items = structured["evidenceItems"].as_array().ok_or_else(refused)?;
    let mut output = Vec::new();
    for item in items {
        check(c)?;
        if Instant::now() >= deadline {
            return Err(refused());
        }
        let object = item.as_object().ok_or_else(refused)?;
        let refs = match &item["evidenceRefs"] {
            Value::Null => &[][..],
            Value::Array(v) => v.as_slice(),
            _ => return Err(refused()),
        };
        if refs.iter().any(Value::is_null) {
            return Err(refused());
        }
        let locator = if truthy(&item["sourceLocator"]) {
            &item["sourceLocator"]
        } else {
            refs.first().map(|r| &r["ref"]).unwrap_or(&Value::Null)
        };
        let normalized = if locator.is_null() {
            String::new()
        } else {
            normalize(&crate::native_research_claims::raw_string(locator)?)
        };
        if normalized.is_empty() {
            continue;
        }
        if normalized.len() > 4096 || normalized.contains('\\') || normalized.contains('\0') {
            return Err(refused());
        }
        let displayed = if Path::new(&normalized).is_absolute() {
            PathBuf::from(&normalized)
        } else {
            crate::native_workspace::resolve_native_workspace_root_v1(
                root,
                Path::new(&normalized),
                None,
            )?
        };
        let absolute =
            crate::native_workspace::resolve_native_workspace_root_v1(root, &displayed, None)?;
        let Some(source_root) = source_root else {
            continue;
        };
        let source_root =
            crate::native_workspace::resolve_native_workspace_root_v1(root, source_root, None)?;
        let Some(hash) = refs.iter().map(|r| &r["hash"]).find(|v| truthy(v)) else {
            continue;
        };
        if !absolute.starts_with(&source_root) {
            continue;
        }
        if output.len() >= 128 {
            return Err(refused());
        }
        let displayed = json!(displayed);
        let default_provenance = Value::String("observed_evidence".into());
        let provenance = if truthy(&item["kind"]) {
            &item["kind"]
        } else {
            &default_provenance
        };
        projected_budget(
            output
                .iter()
                .chain([&item["id"], &displayed, hash, provenance]),
            8,
            128,
        )?;
        let mut candidate = json!({"path":displayed,"hash":hash,"provenance":provenance});
        if object.contains_key("id") {
            candidate["id"] = item["id"].clone();
        }
        output.push(candidate);
    }
    check(c)?;
    if Instant::now() >= deadline {
        return Err(refused());
    }
    Ok(output)
}
