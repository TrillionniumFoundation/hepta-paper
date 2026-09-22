#!/usr/bin/env python3
"""One-use exact continuation of the already reviewed development patch."""
import hashlib
import subprocess

raw = subprocess.check_output([
    'git', 'show',
    'a529c1d1af4f6276f8d0bc1baca9aa9dffc67f10:.github/hepta-local-entrypoint-patch.py',
])
assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == 'b4c8eeca8447a509f7286b41aa5f8abff7baf0fd'
source = raw.decode('utf-8')
old = "    row['remaining'] += ' The explicit --workflow-file"
new = "    row['remaining'] = 'Without --workflow-file the original fail-closed diagnostic remains. The explicit --workflow-file"
assert source.count(old) == 1
source = source.replace(old, new)
anchor = '    Path(SOURCE).write_text(text)\n'
addition = '''    Path(SOURCE).write_text(text)
    local_source = Path(LOCAL).read_text()
    local_source = replace(local_source, '        if let Some(paper) = &options.paper_id {\\n            if expected != format!("autonomous-research:{paper}") {\\n                return Err(WorkflowError::Definition);\\n            }\\n        }', '        if let Some(paper) = &options.paper_id\\n            && expected != format!("autonomous-research:{paper}")\\n        {\\n            return Err(WorkflowError::Definition);\\n        }')
    Path(LOCAL).write_text(local_source)
    test_source = Path(TEST).read_text()
    test_source = replace(test_source, 'now + 120_000', 'now + 600_000')
    test_source = replace(test_source, '    for extra in [vec!["--launch-mode", "production-run"]', '    let options = hepta_paper_service::autonomous_research::parse_autonomous_research_arguments(&["--campaign-id".into(), "campaign-service".into(), "--workflow-file".into(), path.to_str().unwrap().into(), "--action".into(), "launch".into()]).unwrap();\\n    let read_only = hepta_paper_service::autonomous_research::inspect_autonomous_research_v1(&options);\\n    assert_eq!(read_only["ready"], false);\\n    assert!(!temp.state().exists(), "direct inspection must not initialize or execute");\\n    for extra in [vec!["--launch-mode", "production-run"]')
    test_source = replace(test_source, '    value["unknownPrivateText"]', '    let mut expired: LocalWorkflowV1 = serde_json::from_slice(&original).unwrap();\\n    expired.template.observed_at_unix_ms = 1_000;\\n    expired.template.writer_lease.expires_at_unix_ms = 100_000;\\n    fs::write(&path, serde_json::to_vec(&expired).unwrap()).unwrap();\\n    success(invoke(&path, "prepare", &[]));\\n    let rejected = invoke(&path, "launch", &[]);\\n    assert!(!rejected.status.success());\\n    let expired_report: Value = serde_json::from_slice(&rejected.stdout).unwrap();\\n    assert_eq!(expired_report["error"], "local_workflow_lifecycle_or_lease_conflict");\\n    assert!(!temp.state().exists(), "expired actual lease must refuse before initialization");\\n    value["unknownPrivateText"]')
    Path(TEST).write_text(test_source)
'''
assert source.count(anchor) == 1
source = source.replace(anchor, addition)
old = 'Mutations use actual system time and refuse the supplied frozen writer lease\nbefore its initial time or after expiry; this path does not renew a lease.'
new = 'Mutations sample actual system time at command entry and refuse the supplied\nfrozen writer lease before its initial time or after expiry. The underlying\nbatch retains its explicit clock semantics; this wrapper does not provide\ncontinuous lease revalidation, renewal or a production timer supervisor.'
assert source.count(old) == 1
source = source.replace(old, new)
exec(compile(source, '<exact-local-entrypoint-patch>', 'exec'), globals())
