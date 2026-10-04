use super::{SourceObservation, sources::optional_document, values::*};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

fn regex(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).is_ok_and(|r| r.is_match(value))
}
fn ignored_tex(name: &str) -> bool {
    regex(
        r"\.bak|\.backup|\.orig|\.old|\.tmp|\.synctex|supplementary|appendix-only",
        &name.to_lowercase(),
    )
}
fn scoped(source: &SourceObservation<'_>, path: &Path) -> Result<PathBuf, String> {
    observed_relative(source.root(), path)
}
fn exists(
    source: &mut SourceObservation<'_>,
    path: &Path,
    directory: bool,
) -> Result<bool, String> {
    let relative = scoped(source, path)?;
    Ok(source
        .inventory_probe(&relative)?
        .is_some_and(|m| m.directory == directory))
}
fn walk(
    source: &mut SourceObservation<'_>,
    path: &Path,
    depth: usize,
    maximum_depth: usize,
    kind: &str,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > maximum_depth || out.len() >= 5000 {
        return Ok(());
    }
    let relative = scoped(source, path)?;
    for entry in source.inventory_entries(&relative)? {
        if out.len() >= 5000 {
            break;
        }
        if entry.name.starts_with('.') {
            continue;
        }
        let child = path.join(&entry.name);
        if entry.directory {
            if !matches!(
                entry.name.as_str(),
                ".git" | ".lake" | "node_modules" | "__pycache__"
            ) {
                walk(source, &child, depth + 1, maximum_depth, kind, out)?
            }
        } else if entry.regular {
            let name = entry.name.to_lowercase();
            let matched = if kind == "tex" {
                name.ends_with(".tex") && !ignored_tex(&name)
            } else {
                [".pdf", ".zip", ".md", ".json", ".jsonl", ".csv"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
            };
            if matched {
                out.push(child)
            }
        }
    }
    Ok(())
}
fn find_main(
    source: &mut SourceObservation<'_>,
    directory: &Path,
) -> Result<Option<PathBuf>, String> {
    let mut files = Vec::new();
    walk(source, directory, 0, 4, "tex", &mut files)?;
    let score = |path: &Path| {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if name == "main.tex" {
            1000
        } else if name == "manuscript.tex" {
            900
        } else if name.contains("sample") && name.ends_with(".tex") {
            700
        } else {
            500
        }
    };
    files.sort_by(|a, b| {
        score(b).cmp(&score(a)).then_with(|| {
            a.to_string_lossy()
                .encode_utf16()
                .count()
                .cmp(&b.to_string_lossy().encode_utf16().count())
        })
    });
    Ok(files.into_iter().next())
}
fn candidate_dirs(
    source: &mut SourceObservation<'_>,
    paper: &Value,
    root: &Path,
) -> Result<Vec<PathBuf>, String> {
    let slug = field_text(paper, "slug");
    let mut candidates = Vec::new();
    for name in ["source_dir", "canonical_dir"] {
        if let Some(p) = resolve(root, &paper[name]) {
            candidates.push(p)
        }
    }
    for name in [
        "drafts",
        "workspaces",
        "accepted",
        "submission",
        "logs/paperctl",
    ] {
        candidates.push(lexical(&root.join(name).join(&slug)))
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for path in candidates {
        if seen.insert(path.clone()) && exists(source, &path, true)? {
            out.push(path)
        }
    }
    Ok(out)
}
fn file_record(
    source: &mut SourceObservation<'_>,
    path: &Path,
    role: &str,
    record_scope: &Path,
    remaining: &mut usize,
    logical_root: &Path,
) -> Result<Value, String> {
    let relative = scoped(source, path)?;
    let metadata = source
        .inventory_probe(&relative)?
        .ok_or("native_inventory_input_disappeared")?;
    if metadata.directory {
        return Err("native_inventory_regular_file_required".to_owned());
    }
    let (hash, bytes) = source.archive(&relative, 256 * 1024 * 1024)?;
    let nanoseconds =
        i128::from(metadata.mtime_seconds) * 1_000_000_000 + i128::from(metadata.mtime_nanoseconds);
    let identity = json!({"device":metadata.device.to_string(),"inode":metadata.inode.to_string(),"mode":metadata.mode.to_string(),"size":metadata.size,"mtimeNs":nanoseconds.to_string(),"linkCount":metadata.link_count});
    let payload = json!({"version":1,"kind":"ScopedFileIdentity","status":"scoped_file_identity_verified","scopeRoot":record_scope,"path":path,"rootRealPath":record_scope,"realPath":path,"identity":identity,"symlinkComponents":[],"blockers":[]});
    let identity_hash = hash_record("ScopedFileIdentity", &payload)?;
    let receipt = json!({"version":1,"kind":"ScopedFileReadReceipt","status":"scoped_file_read_verified","beforeIdentityHash":identity_hash,"afterIdentityHash":identity_hash,"bytes":bytes,"hash":hash,"blockers":[]});
    let millis = (metadata.mtime_seconds as f64 * 1000.0
        + metadata.mtime_nanoseconds as f64 / 1_000_000.0)
        .trunc();
    let millis: Value = serde_json::from_str(ryu_js::Buffer::new().format(millis))
        .map_err(|_| "native_inventory_time_invalid")?;
    let record = json!({"role":role,"path":logical_relative(logical_root,path)?,"filename":path.file_name().and_then(|s|s.to_str()).ok_or("native_inventory_non_utf8_refused")?,"sizeBytes":bytes,"mtimeMs":millis,"hash":hash,"scopedFileReadReceiptHash":hash_record("ScopedFileReadReceipt",&receipt)?});
    charge(&record, remaining)?;
    Ok(record)
}
fn sort_records(records: &mut [Value]) {
    records.sort_by(|a, b| {
        b["mtimeMs"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["mtimeMs"].as_f64().unwrap_or(0.0))
    });
}
fn artifacts(
    source: &mut SourceObservation<'_>,
    directory: Option<&Path>,
    paper: &Value,
    remaining: &mut usize,
    logical_root: &Path,
) -> Result<Value, String> {
    let mut pdfs = Vec::new();
    let mut zips = Vec::new();
    let mut evidence = Vec::new();
    let root = logical_root.to_path_buf();
    let record_scope = if field_text(paper, "inventory_source") == "proposal_staging" {
        directory.unwrap_or(&root).to_path_buf()
    } else {
        root.clone()
    };
    // Direct records precede scanned records, including genuine duplicates.
    for (field, role, bucket) in [
        ("current_pdf", "compiled_pdf", &mut pdfs),
        ("current_source_zip", "source_or_submission_zip", &mut zips),
    ] {
        let value = field_text(paper, field);
        if value.is_empty() {
            continue;
        }
        let mut candidates = Vec::new();
        if let Some(p) = resolve(&root, &json!(value)) {
            candidates.push(p)
        }
        for parent in ["canonical_dir", "source_dir"] {
            let parent = field_text(paper, parent);
            if !parent.is_empty()
                && let Some(p) = resolve(
                    &root,
                    &json!(lexical(&PathBuf::from(parent).join(&value)).to_string_lossy()),
                )
            {
                candidates.push(p)
            }
        }
        for candidate in candidates {
            if exists(source, &candidate, false)? {
                bucket.push(file_record(
                    source,
                    &candidate,
                    role,
                    &root,
                    remaining,
                    logical_root,
                )?);
                break;
            }
        }
    }
    if let Some(directory) = directory {
        let mut files = Vec::new();
        walk(source, directory, 0, 3, "artifact", &mut files)?;
        for file in files {
            let lower = file
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase();
            if lower.ends_with(".pdf") {
                pdfs.push(file_record(
                    source,
                    &file,
                    "compiled_pdf",
                    &record_scope,
                    remaining,
                    logical_root,
                )?)
            } else if lower.ends_with(".zip") {
                let role = if regex(
                    "source|workspace|submission|package|arxiv|camera|resubmission",
                    &lower,
                ) {
                    "source_or_submission_zip"
                } else {
                    "zip_candidate"
                };
                zips.push(file_record(
                    source,
                    &file,
                    role,
                    &record_scope,
                    remaining,
                    logical_root,
                )?)
            } else if regex(
                "proof|evidence|referee|review|verdict|manifest|production_plan|semantic|readiness|status",
                &lower,
            ) {
                evidence.push(file_record(
                    source,
                    &file,
                    "research_evidence",
                    &record_scope,
                    remaining,
                    logical_root,
                )?);
            }
        }
    }
    sort_records(&mut pdfs);
    sort_records(&mut zips);
    sort_records(&mut evidence);
    Ok(json!({"pdfs":pdfs,"zips":zips,"evidence":evidence}))
}
fn safe_json(value: &Value) -> Value {
    native_json(js_string(value).as_bytes())
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({}))
}
fn submission_intent(
    paper: &Value,
    source: Option<&Path>,
    main: Option<&Path>,
) -> Result<Value, String> {
    let metadata = safe_json(or(&paper["metadata_json"], &json!("{}")));
    let ledger = safe_json(or(&paper["ledger_evidence_json"], &json!("{}")));
    if metadata.is_null() || ledger.is_null() {
        return Err("native_inventory_null_metadata_refused".to_owned());
    }
    let factory = &metadata["paper_factory"];
    let target = field_text(paper, "venue_target");
    let lifecycle = text(or(
        &factory["derived_lifecycle"],
        &ledger["derived_lifecycle"],
    ));
    let ready = if !factory["derived_source_ready"].is_null() {
        &factory["derived_source_ready"]
    } else {
        &ledger["source_ready"]
    };
    let joined = [
        "slug",
        "title",
        "status",
        "canonical_dir",
        "source_dir",
        "ledger_lifecycle_stage",
        "ledger_submission_state",
    ]
    .iter()
    .map(|field| field_text(paper, field).to_lowercase())
    .collect::<Vec<_>>()
    .join(" ");
    Ok(if !target.is_empty() {
        json!({"status":"submission_candidate","disposition":"active_submission","reason":"venue_target_present","venueTarget":target})
    } else if regex(r"(^|[_/ -])archive($|[_/ -])|dropbox_archive", &joined) {
        json!({"status":"non_submission_archive","disposition":"non_submission","reason":"archive_named_asset_without_venue","venueTarget":null})
    } else if lifecycle == "source_not_ready"
        || ready == &json!(false)
        || source.is_none()
        || main.is_none()
    {
        json!({"status":"source_adapt_required","disposition":"manual_source_decision","reason":if main.is_none(){"main_tex_missing"}else{"source_not_ready"},"venueTarget":null})
    } else {
        json!({"status":"needs_venue_decision","disposition":"manual_venue_decision","reason":"venue_target_missing","venueTarget":null})
    })
}
fn refs(records: &[Value]) -> Vec<Value> {
    records.iter().filter_map(|item|{let reference=field_text(item,"path");if reference.is_empty(){None}else{Some(json!({"kind":"path","ref":reference,"hash":nullable(field_text(item,"hash")),"notes":null}))}}).collect()
}
fn seal(kind: &str, mut value: Value, field: &str) -> Result<Value, String> {
    value[field] = json!(hash_paper(kind, &value)?);
    value["semanticIdentityVersion"] = json!(2);
    let mut semantic_subject = value.clone();
    semantic_subject
        .as_object_mut()
        .ok_or("native_inventory_record_invalid")?
        .remove(field);
    value["semanticIdentityHash"] = json!(semantic_hash(kind, &semantic_subject)?);
    Ok(value)
}
pub(super) fn discover(
    source: &mut SourceObservation<'_>,
    record: super::sources::PaperRecordV1,
    created: &str,
    remaining: &mut usize,
    logical_root: &Path,
) -> Result<Value, String> {
    let super::sources::PaperRecordV1 {
        raw,
        coerced: paper,
    } = record;
    let root = logical_root.to_path_buf();
    let dirs = candidate_dirs(source, &paper, &root)?;
    let directory = dirs.first();
    let main = directory
        .map(|p| find_main(source, p))
        .transpose()?
        .flatten();
    let artifacts = artifacts(
        source,
        directory.map(PathBuf::as_path),
        &paper,
        remaining,
        &root,
    )?;
    let main_record = main
        .as_ref()
        .map(|p| {
            file_record(
                source,
                p,
                "main_tex",
                if field_text(&paper, "inventory_source") == "proposal_staging" {
                    directory.map(PathBuf::as_path).unwrap_or(&root)
                } else {
                    &root
                },
                remaining,
                &root,
            )
        })
        .transpose()?;
    let contract = directory
        .map(|p| optional_document(source, &scoped(source, &p.join("paper.json"))?))
        .transpose()?
        .flatten()
        .map(|b| native_json(&b))
        .transpose()?
        .flatten();
    let profile = match contract
        .as_ref()
        .map(|v| field_text(&v["paper_production"], "profile"))
        .as_deref()
    {
        Some("theorem_or_proof_paper") => Some("formal_theorem_or_proof"),
        Some("empirical_or_experiment_paper") => Some("empirical_or_experiment"),
        _ => None,
    };
    let intent = submission_intent(&paper, directory.map(PathBuf::as_path), main.as_deref())?;
    let pdfs = artifacts["pdfs"]
        .as_array()
        .ok_or("native_inventory_artifacts_invalid")?;
    let zips = artifacts["zips"]
        .as_array()
        .ok_or("native_inventory_artifacts_invalid")?;
    let evidence = artifacts["evidence"]
        .as_array()
        .ok_or("native_inventory_artifacts_invalid")?;
    let mut records = main_record.into_iter().collect::<Vec<_>>();
    records.extend(evidence.iter().take(16).cloned());
    records.extend(pdfs.iter().take(4).cloned());
    records.extend(zips.iter().take(4).cloned());
    let refs = refs(&records);
    let declared_title = field_text(&paper, "title");
    let title = if declared_title.is_empty() {
        field_text(&paper, "slug")
    } else {
        declared_title
    };
    let task = seal(
        "PaperTask",
        json!({"version":1,"kind":"PaperTask","channelId":"paper_factory","productLineId":"paper_manuscript_production","workflowId":"paper_production","paperId":field_text(&paper,"slug"),"taskKey":format!("paper_factory:{}",field_text(&paper,"slug")),"title":title,"status":nullable(field_text(&paper,"status")),"venueTarget":nullable(field_text(&paper,"venue_target")),"paperType":nullable(field_text(&paper,"paper_type")),"canonicalDir":nullable(field_text(&paper,"canonical_dir")),"sourceWorkspace":directory.map(|p|logical_relative(&root,p)).transpose()?,"mainTex":main.as_ref().map(|p|logical_relative(&root,p)).transpose()?,"registry":{"inventorySource":nullable(field_text(&paper,"inventory_source")),"status":nullable(field_text(&paper,"status")),"currentVerdict":nullable(field_text(&paper,"current_verdict")),"nextAction":nullable(field_text(&paper,"next_action")),"updatedAt":nullable(field_text(&paper,"updated_at")),"submissionIntent":intent,"ledger":{"lifecycleStage":nullable(field_text(&paper,"ledger_lifecycle_stage")),"submissionState":nullable(field_text(&paper,"ledger_submission_state")),"nextAction":nullable(field_text(&paper,"ledger_next_action"))}},"source":{"exists":directory.is_some(),"candidateDirs":dirs.iter().map(|p|logical_relative(&root,p)).collect::<Result<Vec<_>,_>>()?,"pdfCount":pdfs.len(),"zipCount":zips.len(),"evidenceCount":evidence.len(),"sourceDir":nullable(field_text(&paper,"source_dir")),"currentPdf":nullable(field_text(&paper,"current_pdf")),"currentSourceZip":nullable(field_text(&paper,"current_source_zip"))},"evidenceRefs":refs,"paperQualityProfile":profile,"paperQualityProfiles":profile.into_iter().collect::<Vec<_>>(),"createdAt":created}),
        "taskHash",
    )?;
    let draft = if directory.is_none() {
        "missing_source"
    } else if main.is_some() {
        "source_tex_present"
    } else {
        "source_present"
    };
    let compile = if !pdfs.is_empty() {
        "compiled_pdf_present"
    } else if main.is_some() {
        "build_ready"
    } else {
        "missing_main_tex"
    };
    let seed = evidence.iter().any(|e| {
        regex(
            "proposal.*seed.*contract|claim.*proof.*evidence.*repro.*seed",
            &format!("{} {}", field_text(e, "filename"), field_text(e, "path")).to_lowercase(),
        )
    });
    let research = if seed {
        "proposal_seed_present"
    } else if !evidence.is_empty() {
        "evidence_present"
    } else if !field_text(&paper, "current_verdict").is_empty() {
        "manual_review_only"
    } else {
        "missing_evidence"
    };
    let package = if !zips.is_empty() {
        "package_present"
    } else if !pdfs.is_empty() && main.is_some() {
        "package_ready"
    } else {
        "package_missing"
    };
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if directory.is_none() {
        blockers.push("source_workspace_missing".to_owned())
    }
    if directory.is_some() && main.is_none() {
        blockers.push("main_tex_missing".to_owned())
    }
    if !truth(&paper["venue_target"]) {
        warnings.push("venue_target_missing".to_owned())
    }
    if intent["status"] != "submission_candidate" {
        warnings.push(format!(
            "submission_intent_{}",
            field_text(&intent, "status")
        ))
    }
    if evidence.is_empty() {
        warnings.push("research_evidence_scan_empty".to_owned())
    }
    let readiness = if !blockers.is_empty() {
        "blocked"
    } else if matches!(compile, "compiled_pdf_present" | "build_ready")
        && matches!(package, "package_present" | "package_ready")
    {
        "ready_for_local_dry_run"
    } else {
        "needs_local_package"
    };
    // Incumbent hashes this initial state before its nextAction/autoLevel/stage
    // observation overlay. Keep that persisted v1/hash behavior exactly.
    let mut state = seal(
        "PaperWorkflowState",
        json!({"version":1,"kind":"PaperWorkflowState","taskKey":task["taskKey"],"paperId":task["paperId"],"venue":task["venueTarget"],"sourceWorkspace":task["sourceWorkspace"],"draftStatus":draft,"compileStatus":compile,"researchVerifyStatus":research,"packageStatus":package,"readinessStatus":readiness,"runnerStatus":"not_started","submissionStatus":"not_started","nextAction":null,"autoLevel":null,"stage":null,"submissionIntent":null,"blockers":blockers,"warnings":warnings,"evidenceRefs":refs,"createdAt":created}),
        "stateHash",
    )?;
    let next = if draft == "missing_source" {
        "paper.inventory.scan"
    } else if draft != "source_tex_present" {
        "paper.source.adapt"
    } else if !matches!(
        compile,
        "compiled_pdf_present" | "build_ready" | "build_passed"
    ) {
        "paper.latex.build"
    } else if !matches!(
        research,
        "verified" | "evidence_present" | "proposal_seed_present" | "manual_review_only"
    ) {
        "paper.research.verify"
    } else if !matches!(package, "package_present" | "package_ready") {
        "paper.source.package"
    } else if readiness != "ready_for_local_dry_run" {
        "paper.readiness.gate"
    } else {
        "paper.venue.dry_run"
    };
    state["nextAction"] = json!(if field_text(&paper, "next_action").is_empty() {
        next.to_owned()
    } else {
        field_text(&paper, "next_action")
    });
    state["autoLevel"] = json!(if draft == "missing_source" {
        "inventory_only"
    } else if draft != "source_tex_present" {
        "source_adapt_needed"
    } else if !matches!(
        compile,
        "compiled_pdf_present" | "build_ready" | "build_passed"
    ) {
        "local_build"
    } else if !matches!(package, "package_present" | "package_ready") {
        "local_package"
    } else {
        "local_dry_run"
    });
    state["stage"] = json!(if !blockers.is_empty() {
        "blocked"
    } else if readiness == "ready_for_local_dry_run" {
        "readiness_gate_ready"
    } else if matches!(package, "package_present" | "package_ready") {
        "package_ready"
    } else if matches!(research, "verified" | "evidence_present") {
        "research_verified"
    } else if matches!(compile, "compiled_pdf_present" | "build_ready") {
        "build_ready"
    } else if draft == "source_tex_present" {
        "source_ready"
    } else if draft == "source_present" {
        "inventory_ready"
    } else {
        "blocked"
    });
    Ok(
        json!({"paper":raw,"task":task,"state":state,"artifacts":artifacts,"sourceDir":directory,"mainTex":main,"submissionIntent":intent}),
    )
}
pub(super) fn quarantine_reason(root: &Path, paper: &Value) -> Option<&'static str> {
    let slug = field_text(paper, "slug").to_lowercase();
    if regex(
        r"^rust_patch_queue_shadow|_fixture_|fixture_|test_fixture|shadow_review_|review_flow_(applied|rolled)_back_patch_queue",
        &slug,
    ) {
        return Some("fixture_or_shadow_slug");
    }
    if field_text(paper, "inventory_source") == "proposal_staging" {
        return None;
    }
    let fields = [
        "canonical_dir",
        "source_dir",
        "current_pdf",
        "current_source_zip",
    ]
    .iter()
    .map(|k| field_text(paper, k).replace('\\', "/"))
    .collect::<Vec<_>>();
    let risky = fields.iter().any(|s| {
        regex(
            r"logs/paperctl/_batches/rust|logs/paperctl/.*fixture|tests/fixtures|/tmp/|runtime/",
            &s.to_lowercase(),
        )
    });
    if !risky {
        return None;
    }
    let metadata = safe_json(or(&paper["metadata_json"], &json!("{}")));
    let paths = fields
        .iter()
        .filter(|s| !s.is_empty())
        .filter_map(|s| resolve(root, &json!(s)))
        .collect::<Vec<_>>();
    let permitted = field_text(paper, "inventory_source") == "hepta_sqlite"
        && paper["campaign_local_only"] == true
        && metadata["source"] == "paper_campaign_creation"
        && !field_text(&metadata, "campaignId").is_empty()
        && !paths.is_empty()
        && paths.iter().all(|p| p.starts_with(root));
    if permitted {
        None
    } else {
        Some("fixture_or_shadow_path")
    }
}
pub(super) fn venue(venues: &[Value], coerced: &[Value], target: String) -> Value {
    let target = target.to_lowercase();
    if target.is_empty() {
        return Value::Null;
    }
    venues
        .iter()
        .zip(coerced)
        .find(|(_, v)| field_text(v, "name").to_lowercase() == target)
        .or_else(|| {
            venues
                .iter()
                .zip(coerced)
                .find(|(_, v)| target.contains(&field_text(v, "name").to_lowercase()))
        })
        .map(|(raw, _)| raw.clone())
        .unwrap_or(Value::Null)
}
pub(super) fn loose_drafts(
    source: &mut SourceObservation<'_>,
    known: &BTreeSet<String>,
) -> Result<Vec<Value>, String> {
    let mut rows = Vec::new();
    for entry in source.inventory_entries(Path::new("drafts"))? {
        if !entry.directory || known.contains(&entry.name) {
            continue;
        }
        let path = source.root().join("drafts").join(&entry.name);
        if find_main(source, &path)?.is_none() {
            continue;
        }
        rows.push(json!({"slug":entry.name,"title":entry.name.replace('_'," "),"status":"draft","venue_target":"","paper_type":"","canonical_dir":relative(source.root(),&path)?,"current_verdict":"","next_action":"","updated_at":"","inventory_source":"loose_draft"}));
        if rows.len() > 1024 {
            return Err("native_inventory_rows_v1_exceeded".to_owned());
        }
    }
    Ok(rows)
}
pub(super) fn proposal_staging(
    source: &mut SourceObservation<'_>,
    staging: &Path,
    known: &mut BTreeSet<String>,
    logical_root: &Path,
) -> Result<Vec<Value>, String> {
    use crate::online_runtime_activation::ordered_json::{Json, parse_ordered};
    let relative = scoped(source, staging)?;
    let mut entries = source
        .inventory_entries(&relative)?
        .into_iter()
        .filter(|e| e.regular && e.name.ends_with(".json"))
        .collect::<Vec<_>>();
    let collator =
        hepta_legacy_compatibility::ProductionCollationV1::load().map_err(|e| e.to_string())?;
    entries.sort_by(|a, b| collator.compare(&a.name, &b.name));
    let proposal_root = staging
        .parent()
        .ok_or("native_inventory_staging_invalid")?
        .join("proposals");
    let mut rows = Vec::new();
    for entry in entries {
        let path = staging.join(&entry.name);
        let Some(bytes) = optional_document(source, &scoped(source, &path)?)? else {
            continue;
        };
        if native_json(&bytes)?.is_none() {
            continue;
        }
        let ordered = parse_ordered(&bytes)?;
        let record = ordered.to_value();
        if record["kind"] != "PaperProposalStagingRecord"
            || record["status"] != "proposal_staged_for_inventory"
        {
            continue;
        }
        let slug = field_text(&record, "paperId");
        if slug.is_empty() || known.contains(&slug) {
            continue;
        }
        let Some(workspace) = resolve(logical_root, &record["sourceWorkspace"]) else {
            continue;
        };
        if !workspace.starts_with(&proposal_root) || !exists(source, &workspace, true)? {
            continue;
        }
        let nullable_record = |field: &str| {
            Json::Scalar(if truth(&record[field]) {
                record[field].clone()
            } else {
                Value::Null
            })
        };
        let safety = ordered
            .get("safety")
            .filter(|v| truth(&v.to_value()))
            .cloned()
            .unwrap_or_else(|| Json::Object(Vec::new()));
        let metadata = Json::Object(vec![(
            "proposal_staging".to_owned(),
            Json::Object(vec![
                (
                    "recordPath".to_owned(),
                    Json::Scalar(json!(super::values::logical_relative(logical_root, &path)?)),
                ),
                (
                    "stagingRecordHash".to_owned(),
                    nullable_record("paperProposalStagingRecordHash"),
                ),
                (
                    "proposalEnvelopeHash".to_owned(),
                    nullable_record("proposalEnvelopeHash"),
                ),
                (
                    "productionPlanEnvelopeHash".to_owned(),
                    nullable_record("productionPlanEnvelopeHash"),
                ),
                (
                    "manuscriptSourceContractHash".to_owned(),
                    nullable_record("manuscriptSourceContractHash"),
                ),
                (
                    "paperTaskCreationEnvelopeHash".to_owned(),
                    nullable_record("paperTaskCreationEnvelopeHash"),
                ),
                ("paperTaskHash".to_owned(), nullable_record("paperTaskHash")),
                ("safety".to_owned(), safety),
            ]),
        )])
        .stringify()
        .map_err(|e| e.to_string())?;
        let source_relative = super::values::logical_relative(logical_root, &workspace)?;
        let title = field_text(&record, "title");
        let kind = field_text(&record, "paperType");
        rows.push(json!({"slug":slug,"title":if title.is_empty(){slug.replace('_'," ")}else{title},"status":"proposal_staged","venue_target":field_text(&record,"venueTarget"),"paper_type":if kind.is_empty(){"proposal_generated".to_owned()}else{kind},"canonical_dir":source_relative,"source_dir":source_relative,"current_pdf":"","current_source_zip":"","current_verdict":"","next_action":"paper.latex.build","updated_at":field_text(&record,"createdAt"),"inventory_source":"proposal_staging","metadata_json":metadata,"ledger_lifecycle_stage":"proposal_staging","ledger_submission_state":"","ledger_next_action":"paper.latex.build","ledger_evidence_json":"{}"}));
        known.insert(slug);
        if rows.len() > 1024 {
            return Err("native_inventory_rows_v1_exceeded".to_owned());
        }
    }
    Ok(rows)
}
