//! Observed execution/publication facts retained on refusal; these grant no authority.
use super::*;
use hepta_codex_runtime::CapturedBoundedProcessResultV1;
#[derive(Clone)]
pub(super) struct ExecutionFacts {
    process: Value,
    publication: Option<Value>,
}
impl ExecutionFacts {
    pub(super) fn unknown_prepared() -> Self {
        Self {
            process: Value::Null,
            publication: None,
        }
    }
    pub(super) fn observed(
        actual: &CapturedBoundedProcessResultV1,
        invocation_id: &str,
        private_result: &Path,
        limits: &limits::CpuExecutionLimits,
    ) -> Self {
        let p = &actual.process;
        Self {
            process: serde_json::json!({
                "processInvocationId":invocation_id,"launcherPid":p.process_id,
                "terminationReason":format!("{:?}",p.termination_reason),
                "exitCode":p.exit_code,"signal":p.signal,
                "processGroupCleanupVerified":p.process_group_cleanup_verified,
                "stdoutObservedBytes":p.stdout_bytes,"stderrObservedBytes":p.stderr_bytes,
                "stdoutCapturedBytes":actual.stdout.len(),"stderrRetainedBytes":p.stderr_tail.len(),
                "stdoutTruncated":p.stdout_truncated,"stderrTruncated":p.stderr_truncated,
                "maximumCapturedBytes":limits.maximum_captured_bytes,
            "maximumCombinedOutputBytes":limits.maximum_captured_bytes,
                "timeoutMs":limits.timeout_ms,"privateResultPath":private_result,
                "executionAuthority":false
            }),
            publication: None,
        }
    }
    pub(super) fn preexisting(path: &Path, sha256: &str, bytes: u64) -> Self {
        Self {
            process: Value::Null,
            publication: Some(serde_json::json!({
                "path":path,"sha256":sha256,"bytes":bytes,
                "publicationOutcome":"preexisting_observed","executionAuthority":false,
            })),
        }
    }
    pub(super) fn publication_attempted(&mut self, path: &Path, sha256: &str, bytes: u64) {
        self.publication = Some(
            serde_json::json!({"path":path,"sha256":sha256,"bytes":bytes,
            "publicationOutcome":"attempted_unknown","executionAuthority":false}),
        );
    }
    pub(super) fn publication_saved(&mut self) {
        if let Some(v) = &mut self.publication {
            v["publicationOutcome"] = "saved".into();
        }
    }
    pub(super) fn context(&self, error: String) -> String {
        if error.contains(";cpuExecutionFacts=") {
            return error;
        }
        let facts = serde_json::json!({"version":1,"kind":"NativeCpuRefusalObservedFacts",
            "process":self.process,"publication":self.publication,"executionAuthority":false});
        match serde_json::to_string(&facts) {
            Ok(wire) => format!("{error};cpuExecutionFacts={wire}"),
            Err(_) => format!("{error};cpuExecutionFacts_encoding_refused"),
        }
    }
}
