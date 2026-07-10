import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REFEREE_REVISE_EXPLICIT_RETIREMENTS,
  refereeReviseRetirementDisposition,
} from '../referee-revise-retirements.mjs';

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

assert.equal(REFEREE_REVISE_EXPLICIT_RETIREMENTS.length, 18);
assert.equal(new Set(REFEREE_REVISE_EXPLICIT_RETIREMENTS.map((entry) => entry.sourcePath)).size, 18);

const sourceFiles = REFEREE_REVISE_EXPLICIT_RETIREMENTS.map((entry) => path.join(root, entry.sourcePath));
const auditRun = spawnSync('python3', ['-c', pythonAudit, ...sourceFiles], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  timeout: 120000,
});
assert.equal(auditRun.status, 0, auditRun.stderr);
const audits = JSON.parse(auditRun.stdout);

for (const [index, entry] of REFEREE_REVISE_EXPLICIT_RETIREMENTS.entries()) {
  assert.equal(refereeReviseRetirementDisposition(entry.sourcePath), entry);
  assert.equal(entry.disposition, 'retired_generated_referee_control_evidence_surface');
  assert.ok(entry.reason.length >= 60);
  assert.deepEqual(audits[index].public, entry.publicSymbols, entry.sourcePath);
  assert.deepEqual(audits[index].writes, [], `${entry.sourcePath}: legacy source mutates state`);
  assert.deepEqual(audits[index].external_calls, [], `${entry.sourcePath}: legacy source launches a process`);
  assert.deepEqual(audits[index].network_imports, [], `${entry.sourcePath}: legacy source imports network code`);
  assert.deepEqual(audits[index].process_imports, [], `${entry.sourcePath}: legacy source imports process code`);
  assert.doesNotMatch(productionText, new RegExp(entry.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.equal(refereeReviseRetirementDisposition('paperctl_modules/referee_revision.py'), null);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P1RefereeReviseExplicitRetirementTest',
  retiredSourceCount: REFEREE_REVISE_EXPLICIT_RETIREMENTS.length,
  publicSymbolCount: REFEREE_REVISE_EXPLICIT_RETIREMENTS.reduce(
    (sum, entry) => sum + entry.publicSymbols.length,
    0,
  ),
  sourceWrites: 0,
  sourceExternalCalls: 0,
  heptaProductionReferences: 0,
}) + '\n');
