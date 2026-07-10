import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import {
  RESEARCH_VERIFY_EXPLICIT_RETIREMENTS,
  researchVerifyRetirementDisposition,
} from '../research-verify-retirements.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(workspaceRoot, '..');

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
    process_calls = []
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
                process_calls.append(name)
    results.append({
        "public": public,
        "writes": sorted(set(writes)),
        "process_calls": sorted(set(process_calls)),
        "network_imports": sorted(imported_roots.intersection({"requests", "httpx", "urllib", "socket", "aiohttp"})),
        "subprocess_import": "subprocess" in imported_roots,
        "sqlite_import": "sqlite3" in imported_roots,
    })
print(json.dumps(results, sort_keys=True))
`;

assert.equal(RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.length, 155);
assert.equal(new Set(RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.map((entry) => entry.sourcePath)).size, 155);
const sourceFiles = RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.map((entry) => path.join(root, entry.sourcePath));
const auditRun = spawnSync('python3', ['-c', pythonAudit, ...sourceFiles], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(auditRun.status, 0, auditRun.stderr);
const audits = JSON.parse(auditRun.stdout);
const executionDispositions = new Set([
  'retired_legacy_unbounded_research_executor',
  'retired_research_local_e2e_smoke_harness',
  'retired_legacy_local_formal_verifier_harness',
  'retired_generated_claim_specific_formal_authoring_chain',
  'retired_research_smoke_fixture',
]);

for (const [index, entry] of RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.entries()) {
  assert.equal(researchVerifyRetirementDisposition(entry.sourcePath), entry);
  assert.deepEqual(audits[index].public, entry.publicSymbols, entry.sourcePath);
  assert.deepEqual(audits[index].network_imports, [], `${entry.sourcePath}: imports network code`);
  assert.equal(audits[index].sqlite_import, false, `${entry.sourcePath}: imports SQLite mutation surface`);
  assert.doesNotMatch(productionText, new RegExp(entry.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const hasExecutionSurface = audits[index].writes.length > 0
    || audits[index].process_calls.length > 0
    || audits[index].subprocess_import;
  if (hasExecutionSurface) {
    assert.ok(executionDispositions.has(entry.disposition), `${entry.sourcePath}:${entry.disposition}`);
  }
}

const withWrites = audits.filter((audit) => audit.writes.length > 0).length;
const withProcessCalls = audits.filter((audit) => audit.process_calls.length > 0).length;
const withSubprocessImport = audits.filter((audit) => audit.subprocess_import).length;
const withExecutionSurface = audits.filter((audit) => (
  audit.writes.length > 0 || audit.process_calls.length > 0 || audit.subprocess_import
)).length;
assert.equal(withWrites, 32);
assert.equal(withProcessCalls, 21);
assert.equal(withSubprocessImport, 33);
assert.equal(withExecutionSurface, 35);

const report = await runResearchVerifyAdapter({
  root,
  row: {
    task: {
      paperId: 'research_retirement_fixture',
      taskKey: 'research_retirement_fixture:paper',
      title: 'Research retirement fixture',
      paperType: 'systems',
      sourceWorkspace: 'hepta-paper-workspace/migration/fixtures/missing-research-source',
      mainTex: 'hepta-paper-workspace/migration/fixtures/missing-research-source/main.tex',
      registry: {},
    },
    state: { evidenceRefs: [] },
  },
  runtimeRoot: path.join(workspaceRoot, 'runtime', 'migration-research-retirement-fixture'),
});
assert.equal(report.safety.readsOnly, true);
assert.equal(report.safety.sourceMutation, false);
assert.equal(report.safety.externalActionPerformed, false);
assert.equal(report.academicEvidenceEligible, false);
assert.equal(report.executedResearchWorkerCount, 0);
assert.equal(report.semanticMigrationVerifiedWorkerCount, 0);
assert.ok(report.researchWorkerCount > 0);
assert.ok(report.workerReceiptCount > 0);
for (const receipt of report.typedContracts.workerReceipts) {
  assert.equal(receipt.capabilityEvidenceClass, 'legacy_worker_catalog_reference_only');
  assert.equal(receipt.legacyWorkerExecutionPerformed, false);
  assert.equal(receipt.semanticMigrationVerified, false);
}

const byDisposition = Object.fromEntries(
  [...new Set(RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.map((entry) => entry.disposition))]
    .sort()
    .map((disposition) => [
      disposition,
      RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.filter((entry) => entry.disposition === disposition).length,
    ]),
);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P1ResearchVerifyExplicitRetirementTest',
  retiredSourceCount: RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.length,
  publicSymbolCount: RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.reduce((sum, entry) => sum + entry.publicSymbols.length, 0),
  purePlanOrReportSourceCount: RESEARCH_VERIFY_EXPLICIT_RETIREMENTS.length - withExecutionSurface,
  withExecutionSurface,
  withWrites,
  withProcessCalls,
  withSubprocessImport,
  networkSourceCount: 0,
  byDisposition,
  nativeExecutedWorkerCount: report.executedResearchWorkerCount,
  nativeSemanticMigrationVerifiedWorkerCount: report.semanticMigrationVerifiedWorkerCount,
  academicEvidenceEligible: report.academicEvidenceEligible,
}) + '\n');
