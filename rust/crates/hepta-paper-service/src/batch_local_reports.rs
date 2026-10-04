//! Bounded local report artifacts. These calculations and local receipts do not
//! grant campaign, scientific, release or submission authority.
mod persistence;
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json,
    parse_and_hash_production_record_v1, parse_production_json_v1,
    production_json_pretty_resources_v1, production_json_pretty_with_limits_v1,
    production_json_stringify_with_limits_v1,
};
pub use persistence::{NativeLocalReportPersistenceV1, persist_native_local_batch_report_v1};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

#[derive(Debug)]
pub struct NativeLocalReportArtifactV1 {
    pub relative_path: String,
    pub role: &'static str,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}
#[derive(Debug)]
pub struct NativeLocalReportDetailV1 {
    pub artifact: NativeLocalReportArtifactV1,
    pub detail_hash: String,
}
fn refused() -> String {
    "native_local_report_input_or_budget_v1_refused".into()
}
fn active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("native_local_report_cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("native_local_report_deadline_v1_exceeded".into());
    }
    Ok(())
}
fn limits() -> ProductionJsonEncodingLimitsV1 {
    ProductionJsonEncodingLimitsV1 {
        maximum_bytes: 16 * 1024 * 1024 - 1,
        maximum_values: 1_000_000,
        maximum_utf16_units: 8 * 1024 * 1024,
    }
}
fn key(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
fn string(value: &str) -> Json {
    Json::String(key(value))
}
fn object(values: Vec<(&str, Json)>) -> Json {
    Json::Object(values.into_iter().map(|(k, v)| (key(k), v)).collect())
}
fn get<'a>(value: &'a Json, name: &str) -> Result<&'a Json, String> {
    match value {
        Json::Object(v) => v
            .iter()
            .find(|(k, _)| *k == key(name))
            .map(|(_, v)| v)
            .ok_or_else(refused),
        _ => Err(refused()),
    }
}
fn text(value: &Json) -> Result<String, String> {
    match value {
        Json::String(v) => String::from_utf16(v).map_err(|_| refused()),
        _ => Err(refused()),
    }
}
fn number(value: &Json, expected: f64) -> bool {
    matches!(value,Json::Number(v) if *v==expected)
}
fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn pretty(value: &Json, cancelled: &AtomicBool, deadline: Instant) -> Result<Vec<u8>, String> {
    active(cancelled, deadline)?;
    let resources =
        production_json_pretty_resources_v1(value, limits(), cancelled).map_err(|_| refused())?;
    let mut bytes =
        production_json_pretty_with_limits_v1(value, limits(), cancelled).map_err(|_| refused())?;
    if bytes.len() != resources.bytes {
        return Err(refused());
    }
    bytes.push(b'\n');
    active(cancelled, deadline)?;
    Ok(bytes)
}
fn hash(
    kind: &str,
    value: &Json,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<String, String> {
    active(cancelled, deadline)?;
    let bytes = production_json_stringify_with_limits_v1(value, limits(), cancelled)
        .map_err(|_| refused())?;
    let digest = parse_and_hash_production_record_v1(kind, &bytes).map_err(|_| refused())?;
    active(cancelled, deadline)?;
    Ok(digest.as_str().into())
}
fn admission(wire: &[u8], cancelled: &AtomicBool, deadline: Instant) -> Result<Json, String> {
    active(cancelled, deadline)?;
    if wire.len() > 16 * 1024 * 1024 {
        return Err(refused());
    }
    let value = parse_production_json_v1(wire).map_err(|_| refused())?;
    if !number(get(&value, "version")?, 2.0) || text(get(&value, "kind")?)? != "PaperBatchRunReport"
    {
        return Err(refused());
    }
    production_json_pretty_resources_v1(&value, limits(), cancelled).map_err(|_| refused())?;
    let original_hash = text(get(&value, "reportHash")?)?;
    let Json::Object(fields) = &value else {
        return Err(refused());
    };
    let payload = Json::Object(
        fields
            .iter()
            .filter(|(k, _)| *k != key("reportHash"))
            .cloned()
            .collect(),
    );
    if !digest(&original_hash)
        || hash("PaperBatchRunReport", &payload, cancelled, deadline)? != original_hash
    {
        return Err(refused());
    }
    if !matches!(get(&value, "rows")?, Json::Array(_))
        || !matches!(get(&value, "results")?, Json::Array(_))
    {
        return Err(refused());
    }
    let mode = text(get(&value, "mode")?)?;
    if !matches!(
        mode.as_str(),
        "inventory"
            | "local-build"
            | "local-package"
            | "research-verify"
            | "empirical-analysis"
            | "referee-review"
            | "referee-revise"
            | "local-review-loop"
            | "referee-autopilot"
            | "local-dry-run"
            | "reviewed-submit"
    ) {
        return Err(refused());
    }
    active(cancelled, deadline)?;
    Ok(value)
}
/// Prepare the original detail payload from an actual hash-verified report wire.
/// Raw JSON parsing preserves source insertion order and UTF-16 values.
pub fn prepare_native_local_report_detail_v1(
    wire: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<NativeLocalReportDetailV1, String> {
    let report = admission(wire, cancelled, deadline)?;
    let payload = object(vec![
        ("version", Json::Number(2.0)),
        ("kind", string("PaperBatchResultDetail")),
        ("mode", get(&report, "mode")?.clone()),
        ("rows", get(&report, "rows")?.clone()),
        ("results", get(&report, "results")?.clone()),
    ]);
    let detail_hash = hash("PaperBatchResultDetail", &payload, cancelled, deadline)?;
    Ok(NativeLocalReportDetailV1 {
        artifact: NativeLocalReportArtifactV1 {
            relative_path: format!("details/{}.json", &detail_hash[7..]),
            role: "paper_batch_result_detail",
            content_type: "application/json",
            bytes: pretty(&payload, cancelled, deadline)?,
        },
        detail_hash,
    })
}
fn with_report_hash(
    mut value: Json,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Json, String> {
    let receipt = hash("PaperBatchRunReport", &value, cancelled, deadline)?;
    let Json::Object(v) = &mut value else {
        return Err(refused());
    };
    v.push((key("reportHash"), string(&receipt)));
    Ok(value)
}
struct TextOutput<'a> {
    bytes: Option<Vec<u8>>,
    count: usize,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl TextOutput<'_> {
    fn append_json(&mut self, value: &Json) -> Result<(), String> {
        active(self.cancelled, self.deadline)?;
        let resources = production_json_pretty_resources_v1(value, limits(), self.cancelled)
            .map_err(|_| refused())?;
        let total = self
            .count
            .checked_add(resources.bytes)
            .ok_or_else(refused)?;
        if total > 16 * 1024 * 1024 {
            return Err(refused());
        }
        if self.bytes.is_some() {
            let bytes = production_json_pretty_with_limits_v1(value, limits(), self.cancelled)
                .map_err(|_| refused())?;
            self.append(&bytes)?;
        } else {
            self.count = total;
        }
        Ok(())
    }
    fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        active(self.cancelled, self.deadline)?;
        if self
            .count
            .checked_add(bytes.len())
            .is_none_or(|v| v > 16 * 1024 * 1024)
        {
            return Err(refused());
        }
        self.count += bytes.len();
        if let Some(output) = &mut self.bytes {
            output.extend_from_slice(bytes);
        }
        Ok(())
    }
}
fn markdown_output<'a>(
    report: &Json,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    emit: bool,
) -> Result<TextOutput<'a>, String> {
    let queue = object(vec![
        ("status", get(report, "status")?.clone()),
        ("executionStatus", get(report, "executionStatus")?.clone()),
        ("campaigns", get(report, "campaignSubmissions")?.clone()),
    ]);
    let mut out = TextOutput {
        bytes: emit.then(Vec::new),
        count: 0,
        cancelled,
        deadline,
    };
    out.append(format!("# Paper Batch {}\n\n```json\n", text(get(report, "mode")?)?).as_bytes())?;
    out.append_json(get(report, "summary")?)?;
    out.append(b"\n```\n\n## Campaign Queue\n\n```json\n")?;
    out.append_json(&queue)?;
    out.append(b"\n```\n\n## Blocker Families\n\n")?;
    out.append(text(get(report, "blockerFamilyTable")?)?.as_bytes())?;
    out.append(b"\n\n## Batch Table\n\n")?;
    out.append(text(get(report, "markdownTable")?)?.as_bytes())?;
    Ok(out)
}
/// Complete the other four original local artifacts with a detail receipt bound
/// to the actual CAS/manifest/ledger writer. No report-provenance record is trust.
pub fn prepare_native_local_report_outputs_v1(
    wire: &[u8],
    detail_receipt_wire: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<NativeLocalReportArtifactV1>, String> {
    let report = admission(wire, cancelled, deadline)?;
    if detail_receipt_wire.len() > 64 * 1024 {
        return Err(refused());
    }
    let receipt = parse_production_json_v1(detail_receipt_wire).map_err(|_| refused())?;
    for field in ["hash", "manifestHash", "writeReceiptHash"] {
        if !digest(&text(get(&receipt, field)?)?) {
            return Err(refused());
        }
    }
    let detail = prepare_native_local_report_detail_v1(wire, cancelled, deadline)?;
    use sha2::Digest;
    let expected_hash = format!(
        "sha256:{}",
        hex::encode(sha2::Sha256::digest(&detail.artifact.bytes))
    );
    if text(get(&receipt, "hash")?)? != expected_hash
        || !number(get(&receipt, "bytes")?, detail.artifact.bytes.len() as f64)
        || text(get(&receipt, "kind")?)? != "ArtifactWriteReceipt"
        || !number(get(&receipt, "version")?, 2.0)
        || text(get(&receipt, "path")?)? != detail.artifact.relative_path
        || text(get(&receipt, "role")?)? != "paper_batch_result_detail"
        || !matches!(get(&receipt, "atomic")?, Json::Bool(true))
        || !matches!(get(&receipt, "immutableObject")?, Json::Bool(true))
        || !matches!(get(&receipt, "externalActionPerformed")?, Json::Bool(false))
        || text(get(&receipt, "ledgerReceiptId")?)?
            != format!(
                "report-artifact:{}",
                text(get(&receipt, "writeReceiptHash")?)?
            )
    {
        return Err(refused());
    }
    let result_detail = object(vec![
        ("path", string(&detail.artifact.relative_path)),
        ("detailHash", string(&detail.detail_hash)),
        ("contentHash", get(&receipt, "hash")?.clone()),
        ("manifestHash", get(&receipt, "manifestHash")?.clone()),
        (
            "writeReceiptHash",
            get(&receipt, "writeReceiptHash")?.clone(),
        ),
        ("ledgerReceiptId", get(&receipt, "ledgerReceiptId")?.clone()),
    ]);
    let Json::Object(fields) = &report else {
        return Err(refused());
    };
    let mut fields = fields
        .iter()
        .filter(|(k, _)| *k != key("reportHash") && *k != key("results"))
        .cloned()
        .collect::<Vec<_>>();
    fields.push((key("resultDetail"), result_detail));
    let persisted = with_report_hash(Json::Object(fields), cancelled, deadline)?;
    let mode = text(get(&report, "mode")?)?;
    let generated = text(get(&report, "generatedAt")?)?;
    if !generated.is_ascii() {
        return Err(refused());
    }
    let millis = crate::local_golden_dataset::parse_iso_millis(&generated).ok_or_else(refused)?;
    if crate::sqlite_mutation_coordinator::clock::iso(millis).map_err(|_| refused())? != generated {
        return Err(refused());
    }
    let expiry = crate::sqlite_mutation_coordinator::clock::iso(
        millis.checked_add(86400000).ok_or_else(refused)?,
    )
    .map_err(|_| refused())?;
    let stamp = format!("{}Z", generated[..19].replace(['-', ':'], ""));
    let base = format!("paper-batch-{mode}-{stamp}");
    let pointer = object(vec![
        ("version", Json::Number(1.0)),
        ("kind", string("CurrentReportPointer")),
        ("status", string("current_report_pointer")),
        ("mode", string(&mode)),
        ("reportPath", string(&format!("{base}.json"))),
        ("reportHash", get(&persisted, "reportHash")?.clone()),
        ("generatedAt", string(&generated)),
        ("validUntil", string(&expiry)),
        ("codeProvenance", get(&report, "codeProvenance")?.clone()),
    ]);
    // Aggregate admission precedes the four following output buffers. Detail
    // receipt validation above independently admits its prior 16MiB artifact.
    // Individual encoders
    // still check each append and cannot raise their original 16MiB limits.
    let persisted_size = production_json_pretty_resources_v1(&persisted, limits(), cancelled)
        .map_err(|_| refused())?
        .bytes
        .checked_add(1)
        .ok_or_else(refused)?;
    let markdown_size = markdown_output(&persisted, cancelled, deadline, false)?.count;
    let pointer_size = production_json_pretty_resources_v1(&pointer, limits(), cancelled)
        .map_err(|_| refused())?
        .bytes
        .checked_add(1)
        .ok_or_else(refused)?;
    let pointer_md_size = pointer_size
        .checked_add(b"# Current report pointer\n\n```json\n".len() + b"\n```\n".len() - 1)
        .ok_or_else(refused)?;
    let aggregate = [persisted_size, markdown_size, pointer_size, pointer_md_size]
        .into_iter()
        .try_fold(0usize, usize::checked_add)
        .ok_or_else(refused)?;
    if aggregate > 40 * 1024 * 1024 || pointer_md_size > 16 * 1024 * 1024 {
        return Err(refused());
    }
    let pointer_json = pretty(&pointer, cancelled, deadline)?;
    let mut pointer_md = b"# Current report pointer\n\n```json\n".to_vec();
    pointer_md.extend_from_slice(&pointer_json[..pointer_json.len() - 1]);
    pointer_md.extend_from_slice(b"\n```\n");
    let output = vec![
        NativeLocalReportArtifactV1 {
            relative_path: format!("{base}.json"),
            role: "paper_batch_report",
            content_type: "application/json",
            bytes: pretty(&persisted, cancelled, deadline)?,
        },
        NativeLocalReportArtifactV1 {
            relative_path: format!("{base}.md"),
            role: "paper_batch_report_markdown",
            content_type: "text/plain",
            bytes: markdown_output(&persisted, cancelled, deadline, true)?
                .bytes
                .ok_or_else(refused)?,
        },
        NativeLocalReportArtifactV1 {
            relative_path: format!("paper-batch-{mode}-latest.json"),
            role: "paper_batch_current_report_pointer",
            content_type: "application/json",
            bytes: pointer_json,
        },
        NativeLocalReportArtifactV1 {
            relative_path: format!("paper-batch-{mode}-latest.md"),
            role: "paper_batch_current_report_pointer_markdown",
            content_type: "text/plain",
            bytes: pointer_md,
        },
    ];
    if output
        .iter()
        .try_fold(0usize, |a, v| a.checked_add(v.bytes.len()))
        != Some(aggregate)
    {
        return Err(refused());
    }
    active(cancelled, deadline)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hepta_codex_runtime::{
        BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
        run_bounded_process_capturing_stdout_with_cancellation,
    };
    use serde_json::{Value, json};
    use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, time::Duration};
    #[test]
    fn pretty_json_wire_matches_actual_node_and_preserves_compact_hash_mode() {
        let cases = [
            r#"null"#,
            r#"true"#,
            r#"[]"#,
            r#"{}"#,
            r#"[[],{},null,false]"#,
            r#"{"z":1,"a":2,"10":3,"2":4,"z":5}"#,
            r#"{"01":1,"4294967295":2,"4294967294":3}"#,
            r#"[-0,1.0,1e-6,1e-7,1e20,1e21,9007199254740993,1e400,-1e400]"#,
            r#"["\ud800","\udc00","\ud83d\ude00","\b\f\n\r\t\u0000\u001f", "é","é","😀"]"#,
            r#"{"\ud800":1,"a":2,"\ud800":3}"#,
            r#"{"z":{"2":7,"1":8,"beta":9},"a":["text",{},[],true]}"#,
        ];
        let script = format!(
            "{}\n{}",
            include_str!("release_replay/oracle-input-guard.mjs"),
            r#"const input=readBoundedReplayInput('referee');const actual=input.cases.map(c=>{if(c.name!=='pretty_json'||c.args.length!==1)throw new Error('pretty_case');const v=JSON.parse(c.args[0]);return {pretty:JSON.stringify(v,null,2),compact:JSON.stringify(v)};});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},actual}));"#
        );
        let environment = EnvironmentPolicyV1::new(
            "actual-local-report-json-v1",
            ["PATH", "LANG", "LC_ALL"],
            ["PATH"],
        )
        .unwrap()
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
            ]),
        )
        .unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let result=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1{executable:PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("existing producer qualified Node input")),arguments:vec!["--input-type=module".into(),"--eval".into(),script.into()],working_directory:root,environment,stdin:Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":cases.iter().map(|v|json!({"name":"pretty_json","args":[v]})).collect::<Vec<_>>()})).unwrap())},ProcessLimitsV1{timeout_ms:60000,termination_grace_ms:100,cleanup_timeout_ms:2000,maximum_stdin_bytes:64*1024,maximum_stdout_bytes:1024*1024,maximum_stderr_bytes:64*1024,maximum_tail_bytes:4096,..ProcessLimitsV1::default()},&AtomicBool::new(false)).unwrap();
        assert_eq!(
            result.process.termination_reason,
            ProcessTerminationReason::Exited
        );
        assert_eq!(result.process.exit_code, Some(0));
        assert!(result.process.process_group_cleanup_verified);
        assert_eq!(result.process.stderr_bytes, 0);
        let actual: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(
            actual["profile"],
            json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
        );
        assert_eq!(actual["actual"].as_array().unwrap().len(), cases.len());
        let cancelled = AtomicBool::new(false);
        for (i, input) in cases.iter().enumerate() {
            let value = parse_production_json_v1(input.as_bytes()).unwrap();
            let out = production_json_pretty_with_limits_v1(&value, limits(), &cancelled).unwrap();
            assert_eq!(
                String::from_utf8(out.clone()).unwrap(),
                actual["actual"][i]["pretty"].as_str().unwrap(),
                "case{i}"
            );
            assert_eq!(
                hepta_legacy_compatibility::production_json_stringify_v1(&value).unwrap(),
                actual["actual"][i]["compact"].as_str().unwrap().as_bytes()
            );
            let measured =
                production_json_pretty_resources_v1(&value, limits(), &cancelled).unwrap();
            assert_eq!(measured.bytes, out.len());
            let tight = ProductionJsonEncodingLimitsV1 {
                maximum_bytes: out.len() - 1,
                ..limits()
            };
            assert!(production_json_pretty_with_limits_v1(&value, tight, &cancelled).is_err());
            assert!(production_json_pretty_resources_v1(&value, tight, &cancelled).is_err());
            cancelled.store(true, Ordering::Release);
            assert!(production_json_pretty_with_limits_v1(&value, limits(), &cancelled).is_err());
            cancelled.store(false, Ordering::Release);
        }
        assert!(
            pretty(
                &parse_production_json_v1(b"{}").unwrap(),
                &cancelled,
                Instant::now() - Duration::from_millis(1)
            )
            .is_err()
        );
        println!(
            "actualNode={} codecCases={} cleanup=true localPersistenceAccepted=false",
            result.process.process_id,
            cases.len()
        );
    }
    pub(super) fn actual_five_report_fixture() -> (crate::batch_operator::tests::Fixture, Value) {
        let fixture = crate::batch_operator::tests::Fixture::new_with_actual_node_packages();
        let root = fixture.code.clone();
        let script = format!(
            "{}\n{}",
            include_str!("release_replay/oracle-input-guard.mjs"),
            include_str!("batch_local_reports/oracle.mjs")
        );
        let environment = EnvironmentPolicyV1::new(
            "actual-local-report-five-artifacts-v1",
            ["PATH", "LANG", "LC_ALL"],
            ["PATH"],
        )
        .unwrap()
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
            ]),
        )
        .unwrap();
        let result=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1{executable:PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("existing producer qualified Node input")),arguments:vec!["--input-type=module".into(),"--eval".into(),script.into()],working_directory:root,environment,stdin:Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":[{"name":"local_report","args":[fixture.base.to_str().unwrap()]}]})).unwrap())},ProcessLimitsV1{timeout_ms:60000,termination_grace_ms:100,cleanup_timeout_ms:2000,maximum_stdin_bytes:64*1024,maximum_stdout_bytes:16*1024*1024,maximum_stderr_bytes:128*1024,maximum_tail_bytes:8192,..ProcessLimitsV1::default()},&AtomicBool::new(false)).unwrap();
        assert_eq!(
            result.process.termination_reason,
            ProcessTerminationReason::Exited,
            "{}",
            String::from_utf8_lossy(&result.process.stderr_tail)
        );
        assert_eq!(
            result.process.exit_code,
            Some(0),
            "{}",
            String::from_utf8_lossy(&result.process.stderr_tail)
        );
        assert!(result.process.process_group_cleanup_verified);
        let value: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(
            value["profile"],
            json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
        );
        assert_eq!(value["writerTrusted"], false);
        assert_eq!(value["businessStoreMutated"], false);
        println!(
            "actual five-report Node fixture pid={} cleanup=true",
            result.process.process_id
        );
        (fixture, value)
    }
    #[test]
    fn five_report_artifact_bytes_match_actual_node_inventory_and_local_receipt_writer() {
        use base64ct::{Base64, Encoding};
        let (_fixture, value) = actual_five_report_fixture();
        let wire = value["reportWire"].as_str().unwrap().as_bytes();
        let receipt = serde_json::to_vec(&value["actual"][0]["receipt"]).unwrap();
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(30);
        let detail = prepare_native_local_report_detail_v1(wire, &cancelled, deadline).unwrap();
        let mut outputs = vec![detail.artifact];
        outputs.extend(
            prepare_native_local_report_outputs_v1(wire, &receipt, &cancelled, deadline).unwrap(),
        );
        assert_eq!(outputs.len(), 5);
        for (output, actual) in outputs.iter().zip(value["actual"].as_array().unwrap()) {
            assert_eq!(output.relative_path, actual["path"].as_str().unwrap());
            assert_eq!(output.role, actual["role"].as_str().unwrap());
            assert_eq!(output.content_type, actual["contentType"].as_str().unwrap());
            assert_eq!(
                output.bytes,
                Base64::decode_vec(actual["bytes"].as_str().unwrap()).unwrap(),
                "{}",
                output.relative_path
            );
        }
        let mut wrong = value["actual"][0]["receipt"].clone();
        wrong["bytes"] = json!(1);
        assert!(
            prepare_native_local_report_outputs_v1(
                wire,
                &serde_json::to_vec(&wrong).unwrap(),
                &cancelled,
                deadline
            )
            .is_err()
        );
        wrong = value["actual"][0]["receipt"].clone();
        wrong["externalActionPerformed"] = json!(true);
        assert!(
            prepare_native_local_report_outputs_v1(
                wire,
                &serde_json::to_vec(&wrong).unwrap(),
                &cancelled,
                deadline
            )
            .is_err()
        );
        cancelled.store(true, Ordering::Release);
        assert!(prepare_native_local_report_detail_v1(wire, &cancelled, deadline).is_err());
        cancelled.store(false, Ordering::Release);
        assert!(
            prepare_native_local_report_outputs_v1(
                wire,
                &receipt,
                &cancelled,
                Instant::now() - Duration::from_millis(1)
            )
            .is_err()
        );
        println!(
            "actualReports=5 originalCasReceiptVerification=5 wholeBytesEqual=true writerTrusted=false businessStoreMutated=false nativePersistenceAccepted=false"
        );
    }
}
