use super::{SourceObservation, values::*};
use hepta_readonly_store::{FixedInventoryProjectionV1, InventorySqlCellCoercionV1};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;

pub(super) const MAX_REGISTRY_BYTES: u64 = 256 * 1024;
#[derive(Clone)]
pub(super) struct PaperRecordV1 {
    pub raw: Value,
    pub coerced: Value,
}
impl PaperRecordV1 {
    pub fn plain(raw: Value) -> Self {
        Self {
            coerced: raw.clone(),
            raw,
        }
    }
}
pub(super) struct Registry {
    pub papers: Vec<PaperRecordV1>,
    pub venues: Vec<Value>,
    pub coerced_venues: Vec<Value>,
    pub workflows: Value,
    pub refs: Value,
    pub source: String,
    pub fallback: Value,
}
fn coerced_view(
    raw: &Value,
    cells: &BTreeMap<String, InventorySqlCellCoercionV1>,
) -> Result<Value, String> {
    let fields = raw.as_object().ok_or("native_inventory_sql_row_invalid")?;
    if fields.len() != cells.len() {
        return Err("native_inventory_sql_cell_provenance_missing".to_owned());
    }
    let mut view = raw.clone();
    for field in fields.keys() {
        let cell = cells
            .get(field)
            .ok_or("native_inventory_sql_cell_provenance_missing")?;
        view[field] = json!(cell.string);
    }
    Ok(view)
}

pub(super) fn optional_document(
    source: &mut SourceObservation<'_>,
    relative: &Path,
) -> Result<Option<Vec<u8>>, String> {
    match source.inventory_probe(relative)? {
        None => Ok(None),
        Some(m) if !m.directory => source
            .inventory_document(relative, MAX_REGISTRY_BYTES)
            .map(Some),
        _ => Ok(None),
    }
}
fn document_text(
    source: &mut SourceObservation<'_>,
    relative: &str,
) -> Result<Option<String>, String> {
    optional_document(source, Path::new(relative))?
        .map(|b| {
            String::from_utf8(b).map_err(|_| "native_inventory_registry_utf8_required".to_owned())
        })
        .transpose()
}
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}
fn field(value: &str) -> Option<(&str, &str)> {
    let (k, v) = value.split_once(':')?;
    if valid_key(k) {
        Some((k, v.trim_start()))
    } else {
        None
    }
}
fn numeric(raw: &str) -> bool {
    let raw = raw.strip_prefix('-').unwrap_or(raw);
    let mut parts = raw.split('.');
    let first = parts.next().unwrap_or("");
    !first.is_empty()
        && first.bytes().all(|b| b.is_ascii_digit())
        && parts
            .next()
            .is_none_or(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}
fn maybe_quoted(value: &str) -> Value {
    let raw = value.trim();
    if raw.is_empty() {
        return json!("");
    };
    if raw.len() >= 2
        && ((raw.starts_with('"') && raw.ends_with('"'))
            || (raw.starts_with('\'') && raw.ends_with('\'')))
    {
        return json!(&raw[1..raw.len() - 1]);
    }
    if raw.starts_with('[') && raw.ends_with(']') {
        return json!(
            raw[1..raw.len() - 1]
                .split(',')
                .map(maybe_quoted)
                .filter(truth)
                .collect::<Vec<_>>()
        );
    }
    if raw == "true" {
        return json!(true);
    }
    if raw == "false" {
        return json!(false);
    }
    if numeric(raw) {
        return raw
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .map(|v| serde_json::from_str(ryu_js::Buffer::new().format(v)).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
    }
    json!(raw)
}
fn relevant<'a>(text: &'a str, key: &str) -> impl Iterator<Item = &'a str> {
    let lines = text.split('\n').collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| line.trim() == format!("{key}:"));
    lines
        .into_iter()
        .skip(start.map_or(usize::MAX, |n| n + 1))
        .take_while(|line| {
            !line.chars().next().is_some_and(|c| !c.is_whitespace())
                || line.trim().starts_with('#')
                || line.trim().is_empty()
        })
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
}
fn yaml_list(text: &str, key: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut current: Option<Map<String, Value>> = None;
    for line in relevant(text, key) {
        if let Some((k, v)) = line.strip_prefix("  - ").and_then(field) {
            if let Some(v) = current.take() {
                out.push(Value::Object(v));
            }
            current = Some(Map::from_iter([(k.to_owned(), maybe_quoted(v))]));
        } else if let Some((k, v)) = line.strip_prefix("    ").and_then(field)
            && let Some(row) = &mut current
        {
            row.insert(k.to_owned(), maybe_quoted(v));
        }
        if out.len() > 1024 {
            return Err("native_inventory_registry_rows_v1_exceeded".to_owned());
        }
    }
    if let Some(v) = current {
        out.push(Value::Object(v));
    }
    if out.len() > 1024 {
        return Err("native_inventory_registry_rows_v1_exceeded".to_owned());
    }
    Ok(out)
}
fn yaml_map(text: &str, key: &str) -> Value {
    let mut out = Map::new();
    let mut section = None;
    for line in relevant(text, key) {
        if let Some((k, v)) = line
            .strip_prefix("  ")
            .and_then(field)
            .filter(|(_, v)| v.trim().is_empty())
        {
            let _ = v;
            section = Some(k.to_owned());
            out.insert(k.to_owned(), json!({}));
        } else if let Some((k, v)) = line.strip_prefix("    ").and_then(field)
            && let Some(s) = &section
            && let Some(map) = out.get_mut(s).and_then(Value::as_object_mut)
        {
            map.insert(k.to_owned(), maybe_quoted(v));
        }
    }
    Value::Object(out)
}
pub(super) fn read(
    source: &mut SourceObservation<'_>,
    mode: &str,
    projection: Option<&FixedInventoryProjectionV1>,
    missing_store: bool,
) -> Result<Registry, String> {
    if mode == "legacy-sqlite" {
        return Err(
            "legacy_inventory_runtime_disabled_use_explicit_compatibility_boundary".to_owned(),
        );
    }
    if !matches!(mode, "auto" | "hepta" | "sqlite" | "yaml") {
        return Err(format!("inventory_source_unsupported:{mode}"));
    }
    let pt = document_text(source, "registry/papers.yaml")?;
    let vt = document_text(source, "registry/venues.yaml")?;
    let wt = document_text(source, "registry/workflows.yaml")?;
    let yp = yaml_list(pt.as_deref().unwrap_or(""), "papers")?
        .into_iter()
        .map(PaperRecordV1::plain)
        .collect();
    let yv = yaml_list(vt.as_deref().unwrap_or(""), "venues")?;
    let workflows = yaml_map(wt.as_deref().unwrap_or(""), "workflows");
    let ref_text = |text: &Option<String>, name: &str| {
        if text.as_ref().is_some_and(|s| !s.is_empty()) {
            json!(format!("registry/{name}.yaml"))
        } else {
            Value::Null
        }
    };
    let mut refs = json!({"papers":ref_text(&pt,"papers"),"venues":ref_text(&vt,"venues"),"workflows":ref_text(&wt,"workflows"),"source":"yaml"});
    let sqlite_ok = projection.is_some_and(|p| p.papers.ok);
    let mut sp = Vec::new();
    let mut sv = Vec::new();
    let mut cvs = Vec::new();
    let mut error = json!(if missing_store {
        "sqlite3_not_found"
    } else {
        "native_store_not_injected"
    });
    if let Some(p) = projection {
        if p.papers.ok {
            for row in &p.papers.rows {
                let mut v = serde_json::to_value(row)
                    .map_err(|_| "native_inventory_sql_unicode_refused")?;
                let cells = row.sql_coercions();
                let mut view = coerced_view(&v, cells)?;
                let canonical = if cells
                    .get("source_dir")
                    .ok_or("native_inventory_sql_cell_provenance_missing")?
                    .truthy
                {
                    "source_dir"
                } else {
                    "canonical_dir"
                };
                v["canonical_dir"] = v[canonical].clone();
                view["canonical_dir"] = view[canonical].clone();
                for name in [
                    "source_dir",
                    "current_pdf",
                    "current_source_zip",
                    "ledger_lifecycle_stage",
                    "ledger_submission_state",
                    "ledger_next_action",
                ] {
                    if !cells
                        .get(name)
                        .ok_or("native_inventory_sql_cell_provenance_missing")?
                        .truthy
                    {
                        v[name] = json!("");
                        view[name] = json!("");
                    }
                }
                for name in ["metadata_json", "ledger_evidence_json"] {
                    if !cells
                        .get(name)
                        .ok_or("native_inventory_sql_cell_provenance_missing")?
                        .truthy
                    {
                        v[name] = json!("{}");
                        view[name] = json!("{}");
                    }
                }
                v["inventory_source"] = json!("hepta_sqlite");
                v["campaign_local_only"] = json!(v["campaign_local_only"].as_f64() == Some(1.0));
                view["inventory_source"] = v["inventory_source"].clone();
                view["campaign_local_only"] = v["campaign_local_only"].clone();
                sp.push(PaperRecordV1 {
                    raw: v,
                    coerced: view,
                });
            }
            if p.venues.ok {
                for row in &p.venues.rows {
                    let raw = serde_json::to_value(row)
                        .map_err(|_| "native_inventory_sql_unicode_refused")?;
                    cvs.push(coerced_view(&raw, row.sql_coercions())?);
                    sv.push(raw);
                }
                error = Value::Null;
            } else {
                error = json!(p.venues.error)
            }
        } else {
            error = json!(p.papers.error)
        }
    }
    if mode == "yaml" {
        return Ok(Registry {
            papers: yp,
            coerced_venues: yv.clone(),
            venues: yv,
            workflows,
            refs,
            source: "yaml".to_owned(),
            fallback: Value::Null,
        });
    }
    if matches!(mode, "sqlite" | "hepta") || (mode == "auto" && sqlite_ok && !sp.is_empty()) {
        refs["source"] = json!("hepta_sqlite");
        refs["papers"] = if sqlite_ok {
            json!("hepta-paper.sqlite:papers")
        } else {
            Value::Null
        };
        if sqlite_ok && projection.is_some_and(|p| p.venues.ok) {
            refs["venues"] = json!("hepta-paper.sqlite:venues")
        }
        let fallback = if sv.is_empty() {
            json!("venues_yaml_fallback")
        } else {
            Value::Null
        };
        let (venues, coerced_venues) = if sv.is_empty() {
            (yv.clone(), yv)
        } else {
            (sv, cvs)
        };
        Ok(Registry {
            papers: sp,
            venues,
            coerced_venues,
            workflows,
            refs,
            source: "hepta_sqlite".to_owned(),
            fallback,
        })
    } else {
        Ok(Registry {
            papers: yp,
            coerced_venues: yv.clone(),
            venues: yv,
            workflows,
            refs,
            source: "yaml".to_owned(),
            fallback: if sqlite_ok {
                json!("sqlite_empty_papers")
            } else {
                error
            },
        })
    }
}
