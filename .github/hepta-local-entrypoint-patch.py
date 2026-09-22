#!/usr/bin/env python3
"""One-use, exact-input development patch. Never writes a Git ref or qualification."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path.cwd()
SERVICE = 'rust/crates/hepta-paper-service/'
SOURCE = SERVICE + 'src/autonomous_research.rs'
LOCAL = SERVICE + 'src/autonomous_research/local.rs'
TEST = SERVICE + 'tests/local_workflow/autonomous_entrypoint.rs'
OLD_TEST = SERVICE + 'tests/local_workflow.rs'
DURABLE = SERVICE + 'tests/durable_service.rs'
MAP = 'docs/migration/node-rust-command-map.v1.json'
GAP = 'docs/migration/NODE_RUST_GAP_CLOSURE.md'
README = SERVICE + 'README.md'
HANDOFF = 'docs/modules/LOCAL_WORKFLOW_HANDOFF.md'
EVIDENCE = [
    'docs/system/evidence/repository-source-implementation-v1.json',
    'docs/system/evidence/rust-functional-source-closure-v1.json',
]
TEMP = ['.github/hepta-local-entrypoint-patch.py', '.github/workflows/rust-development-inputs.yml']
ALLOWED = {SOURCE, LOCAL, TEST, OLD_TEST, DURABLE, MAP, GAP, README, HANDOFF, *EVIDENCE, *TEMP}
TESTS = [
    'autonomous_prepare_launch_replay_and_converge_use_the_existing_owner',
    'autonomous_pause_resume_cancel_are_revision_bound_and_terminal',
    'autonomous_rejects_changed_definition_and_foreign_campaign_without_dispatch',
    'autonomous_local_authority_and_request_bounds_fail_before_state_creation',
    'autonomous_executes_real_rust_workers_without_claiming_external_observation',
    'autonomous_worker_crash_is_not_reexecuted_after_cli_restart',
]

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def replace(text, old, new, count=1):
    if text.count(old) != count:
        raise ValueError('exact patch input changed: ' + repr(old[:100]))
    return text.replace(old, new)

def prepare():
    assert git('hash-object', SOURCE) == '3320144ab0b60ab8bf0bb29d7a3a4cdc94cbc143'
    assert git('hash-object', OLD_TEST) == '40e6ed2017f5a20ec90fa0028e4de5cf2965e770'
    text = Path(SOURCE).read_text()
    text = replace(text, 'use serde_json::{Value, json};', 'use serde_json::{Value, json};\nuse std::{collections::BTreeSet, path::PathBuf};\n\nmod local;')
    text = replace(text, '    pub require_full_ready: bool,', '    pub workflow_file: Option<PathBuf>,\n    pub through_steps: Option<usize>,\n    pub expected_revision: Option<u64>,\n    pub require_full_ready: bool,')
    text = replace(text, '    let mut index = 0;', '    let mut workflow_file = None;\n    let mut through_steps = None;\n    let mut expected_revision = None;\n    let mut seen = BTreeSet::new();\n    let mut index = 0;')
    text = replace(text, '        match args[index].as_str() {', '        if !seen.insert(args[index].clone()) {\n            return Err("duplicate_autonomous_research_argument".to_owned());\n        }\n        match args[index].as_str() {')
    text = replace(text, '            "--require-full-ready" if !require_full_ready => {', '''            "--workflow-file" => workflow_file = Some(PathBuf::from(value(args, &mut index, "workflow_file")?)),
            "--through-steps" => through_steps = Some(value(args, &mut index, "through_steps")?.parse::<usize>().map_err(|_| "invalid_autonomous_research_through_steps".to_owned())?),
            "--expected-revision" => expected_revision = Some(value(args, &mut index, "expected_revision")?.parse::<u64>().map_err(|_| "invalid_autonomous_research_expected_revision".to_owned())?),
            "--require-full-ready" if !require_full_ready => {''')
    text = replace(text, '            require_full_ready,\n            help,', '            workflow_file,\n            through_steps,\n            expected_revision,\n            require_full_ready,\n            help,')
    text = replace(text, '        require_full_ready,\n        help,', '        workflow_file,\n        through_steps,\n        expected_revision,\n        require_full_ready,\n        help,')
    text = replace(text, '        "prepare" | "launch" | "status" | "resume" | "converge"', '        "prepare" | "launch" | "status" | "resume" | "converge" | "pause" | "cancel"')
    text = replace(text, '    if paper_id.as_deref()', '''    if workflow_file.is_none() && (through_steps.is_some() || expected_revision.is_some() || matches!(action.as_str(), "pause" | "cancel")) {
        return Err("autonomous_research_workflow_file_required".to_owned());
    }
    if paper_id.as_deref()''')
    text = replace(text, 'pub fn inspect_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {', '''pub fn inspect_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
    if options.workflow_file.is_some() {
        return local::run(options, false);
    }''')
    text = replace(text, 'pub fn execute_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {', '''pub fn execute_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
    if options.workflow_file.is_some() {
        return local::run(options, true);
    }''')
    old_boundary = 'strict argument parsing and fail-closed diagnostic only; no campaign persistence, provider execution, external qualification, or submission'
    text = replace(text, old_boundary, 'explicit local workflow reuses the existing durable owner; without --workflow-file this remains diagnostic-only; no production, live-model or submission authority', 2)
    text = replace(text, '"defaultLaunchMode": "local-run",', '"defaultLaunchMode": "local-run",\n  "localWorkflowUsage": "--campaign-id ID --workflow-file ABSOLUTE_JSON --action prepare|launch|status|converge|pause|resume|cancel [--through-steps N] [--expected-revision N]",', 2)
    text = replace(text, '//! The campaign planner, durable DAG, provider workers, qualification renewal,\n//! and external authority composition remain unported. This module exposes the\n//! strict action/launch-mode boundary and a truthful fail-closed report.', '//! Explicit local workflows use the existing SQLite/CAS and dispatch owners.\n//! Automatic research planning, live models, production qualification renewal\n//! and the complete incumbent business surface remain outside this local path.')
    Path(SOURCE).write_text(text)
    Path(OLD_TEST).write_text('#[path = "local_workflow/autonomous_entrypoint.rs"]\nmod autonomous_entrypoint;\n\n' + Path(OLD_TEST).read_text())

    mapping = json.loads(Path(MAP).read_text())
    assert mapping['acceptedParity'] is False and mapping['productionActivation'] is False and mapping['nodeRetirement'] is False
    rows = [row for row in mapping['commands'] if row['id'] == 'operator/autonomous-research']
    assert len(rows) == 1
    row = rows[0]
    assert row['scope'] == 'partial_local_source'
    row['rustEntrypoint'] = 'hepta-paper-rust autonomous-research --campaign-id ID --workflow-file ABSOLUTE_JSON --action prepare|launch|status|converge|pause|resume|cancel [--through-steps N] [--expected-revision N]'
    additions = [
        {'path': LOCAL, 'symbol': 'run'},
        {'path': SERVICE + 'src/workflow.rs', 'symbol': 'initialize_local_workflow_v1'},
        {'path': SERVICE + 'src/workflow.rs', 'symbol': 'operate_local_workflow_v1'},
    ]
    for entry in additions:
        if entry not in row['callChain']:
            row['callChain'].append(entry)
        if entry['path'] not in row['rustSources']:
            row['rustSources'].append(entry['path'])
    if TEST not in row['tests']:
        row['tests'].append(TEST)
    for name in TESTS:
        entry = {'path': TEST, 'symbol': name}
        if entry not in row['testCases']:
            row['testCases'].append(entry)
    row['remaining'] += ' The explicit --workflow-file local-run path now composes the existing immutable LocalWorkflowV1, SQLite campaign writer, durable dispatch/recovery, CAS byte verification and commit replay without a second scheduler or result store. Prepare validates without creating state; launch initializes an absent root or retries the exact existing owner; converge uses an absolute step endpoint; status is read-only; pause/resume/cancel require the observed campaign revision. Actual CLI tests cover seven-step execution, real Rust child workers, restart/idempotent replay, stale revisions, changed definitions, terminal cancellation, and a crashing child not relaunched across CLI restarts. Process external/network outcomes remain unobserved rather than fabricated false. This bounded path does not implement automatic planning, live author/reviewer models, in-flight termination, lease renewal, all incumbent arguments, independently accepted command parity, production activation, writer transfer or Node retirement.'
    Path(MAP).write_text(json.dumps(mapping, indent=2, ensure_ascii=False) + '\n')
    readme = Path(README).read_text()
    readme = replace(readme, '| `autonomous-research [OPTIONS]` | Parse prepare/launch/status/resume/converge and emit a blocked diagnostic. This route still does not persist a campaign or execute a provider; use of the name execute is not a completed research workflow. |', '| `autonomous-research [OPTIONS]` | With explicit `--workflow-file`, local prepare/launch/status/converge/pause/resume/cancel use the existing immutable workflow, SQLite/CAS and dispatch owner; lifecycle mutations bind `--expected-revision`. Without a workflow file it remains diagnostic-only. This is not automatic research planning, live-model authority or full Node parity. See the local workflow handoff. |')
    Path(README).write_text(readme)
    with Path(HANDOFF).open('a') as out:
        out.write('''

## Autonomous research command composition

The existing `hepta-paper-rust autonomous-research` command now accepts an
explicit `--workflow-file ABSOLUTE_JSON_PATH` in `local-run` mode. The file is
a closed `LocalWorkflowV1`, not another plan, ledger or provider authorization.
`--campaign-id` must match its template; a supplied `--paper-id` must also match
`autonomous-research:<paper-id>`. Files are bounded to 16 MiB, private, current-UID,
single-link, canonical and stable across the read. Unknown typed fields fail.

`--action prepare` validates and hashes the definition without opening or
creating campaign state. `launch` initializes only an absent state root through
`initialize_local_workflow_v1`, then uses `operate_local_workflow_v1`; an existing
root must have the exact retained definition and valid owner history. Partial
initialization and ambiguous dispatch are preserved, never cleaned into success.
`launch` and `converge` accept `--through-steps N`, an absolute endpoint (default:
all steps), so response-loss retries cannot append extra steps or charges.
`status` reads through the same owner without a writer, including after expiry.

`pause`, `resume`, and `cancel` require `--expected-revision N` from the latest
owner status. Stale revisions and reopening a cancelled campaign fail. This is
between-step cancellation, not interruption of an already running provider.
Mutations use actual system time and refuse the supplied frozen writer lease
before its initial time or after expiry; this path does not renew a lease.
Inspection entrypoints cannot mutate even when called directly with forged
options. Production, golden-bootstrap and full-readiness requests fail before
state creation. Omitting `--workflow-file` preserves the previous diagnostic.

The report's `ready` means only that this bounded local operation succeeded;
`readinessScope=local_workflow_operation_only` and `fullResearchReady=false`.
Scientific acceptance, production activation and Node retirement remain false.
Process workers are trusted local programs, not a physical sandbox. Their
provider/external/network outcomes are null (unobserved), never replaced with
an asserted false based on worker JSON or a network declaration. An execution
error reports reconciliation required and retains the original recovery inputs.
No private request content or raw worker diagnostics is printed by this wrapper.

Run from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test autonomous_research_route --test durable_service
```

`tests/local_workflow/autonomous_entrypoint.rs` invokes the actual command and
reuses the existing workflow fixtures. It checks seven-step durable progress,
absolute-endpoint retries, shared status with `hepta-local-workflow`, budget
conservation, stale-revision rejection, pause/resume/terminal cancel, request
substitution, private/oversize/symlink refusal, actual pinned Rust workers and a
crashing child that is not relaunched by repeated fresh CLI processes. These
are local composition tests, not live author/reviewer scientific evaluation,
independent command acceptance, installed host qualification or Node cutover.
''')

def finalize():
    # Refresh exact bindings for changed files only, without changing symbols,
    # tests, outcomes, authority or the required producer set.
    changed = {SOURCE, LOCAL, TEST, OLD_TEST, DURABLE}
    for name in EVIDENCE:
        raw = Path(name).read_text()
        data = json.loads(raw)
        updated = False
        for bundle in data['bundles'].values():
            for entry in bundle['files']:
                if entry['path'] in changed:
                    digest = git('hash-object', entry['path'])
                    if digest != entry['gitBlob']:
                        # Preserve minified formatting and every other field.
                        old = json.dumps({'path': entry['path'], 'role': entry['role'], 'gitBlob': entry['gitBlob']}, separators=(',', ':'))[:-1]
                        new = json.dumps({'path': entry['path'], 'role': entry['role'], 'gitBlob': digest}, separators=(',', ':'))[:-1]
                        raw = replace(raw, old, new)
                        updated = True
        if updated:
            Path(name).write_text(raw)
    subprocess.run(['node', 'docs/tools/generate-node-rust-gap-report.mjs'], check=True)
    for name in TEMP:
        Path(name).unlink()

def export():
    # Called after actual checks, using a copy of this script outside checkout.
    parent = os.environ['SOURCE_HEAD']
    tree = git('rev-parse', 'HEAD^{tree}')
    base = git('rev-parse', parent + '^{tree}')
    names = git('diff', '--name-only', parent, 'HEAD').splitlines()
    assert names and set(names) <= ALLOWED
    entries = []
    for name in names:
        p = Path(name)
        if not p.exists():
            assert name in TEMP
            entries.append({'path': name, 'mode': '100644', 'type': 'blob', 'sha': None})
        else:
            assert p.is_file() and not p.is_symlink()
            entries.append({'path': name, 'mode': '100644', 'type': 'blob', 'content': p.read_text()})
    data = {'repository': 'TrillionniumFoundation/hepta-paper', 'parent': parent, 'base_tree': base, 'expected_tree': tree, 'tree': entries}
    content = json.dumps(data, ensure_ascii=False).encode()
    assert len(content) <= 2 * 1024 * 1024
    output = Path(os.environ['RUNNER_TEMP']) / 'local-entrypoint-candidate'
    output.mkdir(exist_ok=True)
    (output / 'candidate.json').write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    (output / 'candidate.sha256').write_text(digest + '\n')
    print(json.dumps({'parent': parent, 'tree': tree, 'changed': names, 'candidate_sha256': digest}))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
        out.write(f'digest={digest}\ntree={tree}\nbase_tree={base}\n')

if __name__ == '__main__':
    {'prepare': prepare, 'finalize': finalize, 'export': export}[sys.argv[1]]()
