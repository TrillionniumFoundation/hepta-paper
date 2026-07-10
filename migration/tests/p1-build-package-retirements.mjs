import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultLegacyPaperFactoryRoot } from '../../paper-core/src/workspace-layout.mjs';
import {
  BUILD_PACKAGE_EXPLICIT_RETIREMENTS,
  buildPackageRetirementDisposition,
} from '../build-package-retirements.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = defaultLegacyPaperFactoryRoot();
const localWriterPath = 'paperctl_modules/paper_production_runner_execution_contract_artifact_queue.py';

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
                mode = None
                if len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
                    mode = node.args[1].value
                for keyword in node.keywords:
                    if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
                        mode = keyword.value.value
                if isinstance(mode, str) and any(flag in mode for flag in "wax+"):
                    writes.append(name + ":" + mode)
            if name.split(".")[-1] in {
                "write_text", "write_bytes", "unlink", "remove", "rename",
                "mkdir", "makedirs", "rmdir", "removedirs", "touch",
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

assert.equal(BUILD_PACKAGE_EXPLICIT_RETIREMENTS.length, 36);
assert.equal(new Set(BUILD_PACKAGE_EXPLICIT_RETIREMENTS.map((entry) => entry.sourcePath)).size, 36);
const sourceFiles = BUILD_PACKAGE_EXPLICIT_RETIREMENTS.map((entry) => path.join(root, entry.sourcePath));
const auditRun = spawnSync('python3', ['-c', pythonAudit, ...sourceFiles], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  timeout: 120000,
});
assert.equal(auditRun.status, 0, auditRun.stderr);
const audits = JSON.parse(auditRun.stdout);

for (const [index, entry] of BUILD_PACKAGE_EXPLICIT_RETIREMENTS.entries()) {
  assert.equal(buildPackageRetirementDisposition(entry.sourcePath), entry);
  assert.deepEqual(audits[index].public, entry.publicSymbols, entry.sourcePath);
  assert.deepEqual(audits[index].external_calls, [], `${entry.sourcePath}: launches a process`);
  assert.deepEqual(audits[index].network_imports, [], `${entry.sourcePath}: imports network code`);
  assert.deepEqual(audits[index].process_imports, [], `${entry.sourcePath}: imports process code`);
  assert.doesNotMatch(productionText, new RegExp(entry.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (entry.sourcePath === localWriterPath) {
    assert.equal(entry.disposition, 'retired_legacy_local_runner_contract_materializer');
    assert.deepEqual(audits[index].writes, ['path.parent.mkdir', 'path.write_text']);
  } else {
    assert.equal(entry.disposition, 'retired_generated_build_misclassified_control_evidence_surface');
    assert.deepEqual(audits[index].writes, [], `${entry.sourcePath}: unexpected state mutation`);
  }
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-build-retirement-'));
try {
  const localWriterProbe = String.raw`
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, sys.argv[2])
from paperctl_modules.paper_production_runner_execution_contract_artifact_queue import build_runner_execution_contract_artifact_queue
target = {
  "status": "PASS",
  "target_scope_state": "TARGET_SCOPE_RESOLVED",
  "summary": {"target_paper_count": 1, "target_slug_set_hash": "a" * 64},
}
authoring = {
  "status": "PASS",
  "label": "fixture",
  "runner_execution_contract_authoring_surface_state": "READY",
  "summary": {"authoring_surface_ready": True},
  "authoring_surface_matrix": [{
    "authoring_surface_ready": True,
    "expected_contract_path": "logs/paperctl/_contracts/runner_execution/fixture.json",
    "expected_contract_id": "fixture-contract",
    "route_id": "fixture-route",
    "command": "local-fixture-command",
    "runner_lane": "fixture",
    "contract_kind": "delegated_external_runner",
    "external_lifecycle_stage": "blocked",
    "external_lifecycle_readiness_report": "fixture.json",
    "required_contract_fields": [],
    "validation_sequence": [],
    "matrix_hash": "b" * 64,
  }],
}
report = build_runner_execution_contract_artifact_queue(
  target, authoring, {}, "fixture", root, True, "2026-07-10T00:00:00+00:00"
)
files = sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())
print(json.dumps({
  "status": report["status"],
  "state": report["runner_execution_contract_artifact_queue_state"],
  "external_action_authorized": report["external_action_authorized"],
  "external_action_performed": report["external_action_performed"],
  "files": files,
}, sort_keys=True))
`;
  const probe = spawnSync('python3', ['-c', localWriterProbe, fixtureRoot, root], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {
    status: 'PASS',
    state: 'RUNNER_EXECUTION_CONTRACT_ARTIFACT_QUEUE_READY',
    external_action_authorized: false,
    external_action_performed: false,
    files: ['logs/paperctl/_contracts/runner_execution/fixture.json'],
  });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

assert.equal(buildPackageRetirementDisposition('paperctl_modules/not-retired.py'), null);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P1BuildPackageExplicitRetirementTest',
  retiredSourceCount: BUILD_PACKAGE_EXPLICIT_RETIREMENTS.length,
  pureReportSourceCount: 35,
  localContractMaterializerCount: 1,
  publicSymbolCount: BUILD_PACKAGE_EXPLICIT_RETIREMENTS.reduce((sum, entry) => sum + entry.publicSymbols.length, 0),
  externalActions: 0,
  heptaProductionReferences: 0,
}) + '\n');
