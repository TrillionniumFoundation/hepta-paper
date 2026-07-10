import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultLegacyPaperFactoryRoot } from '../../paper-core/src/workspace-layout.mjs';
import { buildSubmissionLifecycle } from '../../paper-adapters/submission/index.mjs';
import {
  SUBMISSION_EXPLICIT_RETIREMENTS,
  submissionRetirementDisposition,
} from '../submission-retirements.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = defaultLegacyPaperFactoryRoot();
const localBundleWriter = 'paperctl_modules/external_submission_handoff_bundle.py';
const directMutationExecutor = 'paperctl_modules/paper_production_repair_executor.py';

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return entry.isFile() ? [absolute] : [];
  });
}

const productionText = [
  ...filesUnder(path.join(workspaceRoot, 'paper-core', 'src')),
  ...filesUnder(path.join(workspaceRoot, 'paper-core', 'bin')),
  ...filesUnder(path.join(workspaceRoot, 'paper-adapters')),
]
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

const pythonAudit = String.raw`
import ast, json, pathlib, sys
results = []
for raw in sys.argv[1:]:
    source = pathlib.Path(raw)
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    public = [
        node.name for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and not node.name.startswith("_")
    ]
    imported_roots = set()
    writes = []
    external_calls = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported_roots.add(node.module.split(".")[0])
        elif isinstance(node, ast.Call):
            name = ""
            if isinstance(node.func, ast.Name):
                name = node.func.id
            elif isinstance(node.func, ast.Attribute):
                parts = []
                current = node.func
                while isinstance(current, ast.Attribute):
                    parts.append(current.attr)
                    current = current.value
                if isinstance(current, ast.Name):
                    parts.append(current.id)
                name = ".".join(reversed(parts))
            if name == "open" or name.endswith(".open"):
                argument_index = 0 if name.endswith(".open") else 1
                mode = None
                if len(node.args) > argument_index and isinstance(node.args[argument_index], ast.Constant):
                    mode = node.args[argument_index].value
                for keyword in node.keywords:
                    if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
                        mode = keyword.value.value
                if isinstance(mode, str) and any(flag in mode for flag in "wax+"):
                    writes.append(name + ":" + mode)
            if name.split(".")[-1] in {
                "write", "writestr", "write_text", "write_bytes", "unlink", "remove",
                "rename", "mkdir", "makedirs", "rmdir", "removedirs", "touch",
                "copy", "copy2", "move",
            }:
                writes.append(name)
            if name in {"os.system", "subprocess.run", "subprocess.call", "subprocess.Popen", "subprocess.check_call", "subprocess.check_output"}:
                external_calls.append(name)
    results.append({
        "public": public,
        "writes": sorted(set(writes)),
        "external_calls": sorted(set(external_calls)),
        "network_imports": sorted(imported_roots.intersection({"requests", "httpx", "urllib", "socket", "aiohttp"})),
        "process_imports": sorted(imported_roots.intersection({"subprocess"})),
    })
print(json.dumps(results, sort_keys=True))
`;

assert.equal(SUBMISSION_EXPLICIT_RETIREMENTS.length, 30);
assert.equal(new Set(SUBMISSION_EXPLICIT_RETIREMENTS.map((entry) => entry.sourcePath)).size, 30);
const sourceFiles = SUBMISSION_EXPLICIT_RETIREMENTS.map((entry) => path.join(root, entry.sourcePath));
const auditRun = spawnSync('python3', ['-c', pythonAudit, ...sourceFiles], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  timeout: 120000,
});
assert.equal(auditRun.status, 0, auditRun.stderr);
const audits = JSON.parse(auditRun.stdout);

for (const [index, entry] of SUBMISSION_EXPLICIT_RETIREMENTS.entries()) {
  assert.equal(submissionRetirementDisposition(entry.sourcePath), entry);
  assert.deepEqual(audits[index].public, entry.publicSymbols, entry.sourcePath);
  assert.deepEqual(audits[index].external_calls, [], `${entry.sourcePath}: launches a process`);
  assert.deepEqual(audits[index].network_imports, [], `${entry.sourcePath}: imports network code`);
  assert.deepEqual(audits[index].process_imports, [], `${entry.sourcePath}: imports process code`);
  assert.doesNotMatch(productionText, new RegExp(entry.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (entry.sourcePath === localBundleWriter) {
    assert.equal(entry.disposition, 'retired_legacy_local_handoff_bundle_writer');
    assert.deepEqual(audits[index].writes, [
      'dest.parent.mkdir', 'path.open:w', 'path.parent.mkdir', 'shutil.copy2', 'zf.write',
    ]);
  } else if (entry.sourcePath === directMutationExecutor) {
    assert.equal(entry.disposition, 'retired_legacy_direct_source_mutation_executor');
    assert.deepEqual(audits[index].writes, [
      'evidence_path.parent.mkdir', 'evidence_path.write_text', 'source_path.write_text',
    ]);
  } else {
    assert.deepEqual(audits[index].writes, [], `${entry.sourcePath}: unexpected state mutation`);
  }
}

const row = {
  task: {
    paperId: 'submission_boundary_fixture',
    taskKey: 'submission_boundary_fixture:paper',
    title: 'Submission boundary fixture',
    paperType: 'systems',
    sourceWorkspace: 'migration/fixtures/missing-source',
    mainTex: 'migration/fixtures/missing-source/main.tex',
    venueTarget: 'Fixture Venue',
    registry: {},
  },
  state: {
    blockers: ['fixture_not_submit_ready'],
    draftStatus: 'source_missing',
    compileStatus: 'not_built',
    packageStatus: 'package_missing',
  },
};

const dryRun = buildSubmissionLifecycle({
  row,
  venues: [],
  artifactPackage: null,
  researchReport: null,
  mode: 'local-dry-run',
  reviewedSubmit: false,
});
const reviewed = buildSubmissionLifecycle({
  row,
  venues: [],
  artifactPackage: null,
  researchReport: null,
  mode: 'reviewed-submit',
  reviewedSubmit: true,
});

for (const lifecycle of [dryRun, reviewed]) {
  assert.equal(lifecycle.safety.dryRunOnly, true);
  assert.equal(lifecycle.safety.externalActionPerformed, false);
  assert.equal(lifecycle.safety.controlledExecutorReceiptRecorded, false);
  assert.equal(lifecycle.safety.liveSubmitRequiresSeparateAuthorization, true);
  assert.equal(lifecycle.approvalPacket.status, 'blocked_approval_packet');
  assert.equal(lifecycle.freshVenueEvidenceBundle.status, 'blocked_fresh_venue_evidence');
  assert.equal(lifecycle.outbox.status, 'blocked_outbox_item');
  assert.equal(lifecycle.receipt.status, 'blocked_run');
  assert.equal(lifecycle.reconciliation.status, 'dry_run_reconciled');
  for (const hash of [
    lifecycle.manifest.manifestHash,
    lifecycle.replayGuard.submissionReplayGuardHash,
    lifecycle.outbox.externalExecutorHandoffOutboxHash,
    lifecycle.receipt.receiptHash,
  ]) assert.match(hash, /^sha256:[a-f0-9]{64}$/);
}
assert.equal(reviewed.reviewedSubmitPreflightPacket.status, 'reviewed_submit_preflight_blocked');
assert.equal(reviewed.controlledExecutorReceipt.status, 'controlled_external_executor_blocked');
assert.notEqual(dryRun.manifest.manifestHash, reviewed.manifest.manifestHash);

const byDisposition = Object.fromEntries(
  [...new Set(SUBMISSION_EXPLICIT_RETIREMENTS.map((entry) => entry.disposition))]
    .sort()
    .map((disposition) => [
      disposition,
      SUBMISSION_EXPLICIT_RETIREMENTS.filter((entry) => entry.disposition === disposition).length,
    ]),
);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P1SubmissionLifecycleBoundaryTest',
  retiredSourceCount: SUBMISSION_EXPLICIT_RETIREMENTS.length,
  publicSymbolCount: SUBMISSION_EXPLICIT_RETIREMENTS.reduce((sum, entry) => sum + entry.publicSymbols.length, 0),
  byDisposition,
  nativeLifecycleExternalActions: 0,
  reviewedSubmitPreflight: reviewed.reviewedSubmitPreflightPacket.status,
  controlledExecutor: reviewed.controlledExecutorReceipt.status,
}) + '\n');
