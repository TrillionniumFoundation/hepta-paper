import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { authorizeOperatorDatasetMount } from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { inspectStrictDatasetManifest } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  createDockerDatasetSupervisorProbeWorkspace,
} from '../../paper-adapters/runtime/docker-dataset-supervisor-probe-repository.mjs';
import { probeTrustedDockerDatasetSupervisors } from '../../paper-adapters/runtime/sandbox-backend-probe.mjs';
import { createOsSandboxedWorkerRunner, fileSha256Hash } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  buildCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCanonicalAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  buildDatasetAuthorizationSet,
  buildExperimentReplayReceipt,
  buildExperimentRunReceipt,
  verifyExperimentReplayReceipt,
  verifyExperimentRunReceipt,
  verifyOsSandboxWorkerReceipt,
  verifySystemBenchmarkHarnessExecutionReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  buildExperimentIrExecutionAuthorityReceipt,
  verifyExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import { buildResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  inspectPersistedExperimentIrExecutionAuthority,
} from '../../paper-composition/automation/automation-readiness-experiment-ir-authority-inspection.mjs';
import {
  validateOperatorDatasetHarnessDefinition,
  validateOperatorDatasetSplitManifest,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const OTHER_DIGEST = `sha256:${'f'.repeat(64)}`;
const dockerImagesPresent = [AUTOMATION_RUNTIME_IMAGES.python, AUTOMATION_RUNTIME_IMAGES.r]
  .every((runtime) => spawnSync('docker', ['image', 'inspect', runtime.image], { encoding: 'utf8', timeout: 15000 }).status === 0);
const academicDockerOperationalMode = String(process.env.HEPTA_ACADEMIC_DOCKER_OPERATIONAL_MODE || '');
const academicDockerOperational = ['strict', 'diagnostic'].includes(academicDockerOperationalMode);
const academicDockerOperationalOptions = Object.freeze({
  skip: !dockerImagesPresent || !academicDockerOperational,
});

function trustedProfile(runtime = AUTOMATION_RUNTIME_IMAGES.python) {
  return {
    image: runtime.image,
    imageDigest: runtime.imageDigest,
    containerExecutable: runtime.executable,
    supervisor: runtime.datasetAccessSupervisor,
  };
}

function trustedDockerImageInspection(runtime) {
  return {
    status: 0,
    stdout: JSON.stringify([{
      Descriptor: {
        digest: runtime.imageDigest,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
      },
      Os: 'linux',
      Architecture: 'amd64',
      Config: { Labels: {
        'io.hepta.dataset-supervisor.protocol': runtime.datasetAccessSupervisor.protocol,
        'io.hepta.dataset-supervisor.sha256': runtime.datasetAccessSupervisor.sha256,
      } },
    }]),
    stderr: '',
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-docker-supervisor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const datasets = path.join(root, 'datasets');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(source);
  fs.mkdirSync(datasets);
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(source, 'main.py'), `import json, os, pathlib
content=pathlib.Path('/datasets/probe').read_text()
denied=False
try: pathlib.Path('/hepta-supervisor/dataset-access.trace').write_text('FORGED')
except PermissionError: denied=True
status=pathlib.Path('/proc/self/status').read_text().splitlines()
cap=next(line.split()[1] for line in status if line.startswith('CapEff:'))
pathlib.Path('/output/results.json').write_text(json.dumps({'bytes':len(content.encode()),'uid':os.getuid(),'traceOverwriteDenied':denied,'capEff':cap}))
pathlib.Path('/output/results.csv').write_text('metric,value\\nbytes,'+str(len(content.encode()))+'\\n')
`);
  fs.writeFileSync(path.join(source, 'main.R'), `content <- readBin('/datasets/probe', 'raw', n=file.info('/datasets/probe')$size)
denied <- inherits(try(writeLines('FORGED', '/hepta-supervisor/dataset-access.trace'), silent=TRUE), 'try-error')
status <- readLines('/proc/self/status')
cap <- sub('^CapEff:[[:space:]]*', '', status[grepl('^CapEff:', status)])
uid <- as.integer(strsplit(sub('^Uid:[[:space:]]*', '', status[grepl('^Uid:', status)]), '[[:space:]]+')[[1]][1])
jsonlite::write_json(list(bytes=length(content), uid=uid, traceOverwriteDenied=denied, capEff=cap), '/output/results.json', auto_unbox=TRUE)
writeLines(c('metric,value', sprintf('bytes,%d', length(content))), '/output/results.csv')
`);
  const dataset = path.join(datasets, 'probe.json');
  fs.writeFileSync(dataset, '{"value":42}\n');
  const mount = {
    name: 'probe',
    source: dataset,
    readOnly: true,
    manifestHash: fileSha256Hash(dataset),
    licenseId: 'CC-BY-4.0',
  };
  const authorizationSet = buildDatasetAuthorizationSet([mount]);
  return { root, source, datasets, artifacts, mount, authorizationSet };
}

function runnerFor(f, {
  runtime = AUTOMATION_RUNTIME_IMAGES.python,
  image = runtime.image,
  resolvedDigest = runtime.imageDigest,
  trustedProfiles = [trustedProfile(runtime)],
} = {}) {
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [runtime.executable],
    allowedRoots: [f.source],
    allowedOutputRoots: [f.artifacts],
    allowedDatasetRoots: [f.datasets],
    allowedContainerImages: [image],
    trustedDatasetSupervisorImages: trustedProfiles,
    imageDigestResolver: () => resolvedDigest,
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', processLimit: { available: true, mechanism: 'docker-pids-cgroup' } },
  });
}

function runSpec(f, runner, {
  runtime = AUTOMATION_RUNTIME_IMAGES.python,
  image = runtime.image,
  executionIdentity = null,
  outputDirectory = f.artifacts,
} = {}) {
  const identity = executionIdentity || runner.resolveExecutionRuntimeIdentity({
    executable: runtime.executable,
    containerImage: image,
    containerExecutable: runtime.executable,
  });
  return runner.run({
    executable: runtime.executable,
    args: [runtime === AUTOMATION_RUNTIME_IMAGES.r ? 'main.R' : 'main.py'],
    cwd: f.source,
    sourceRoot: f.source,
    outputPaths: ['results.json', 'results.csv'],
    outputDirectory,
    requireSeparateOutputRoot: true,
    containerImage: image,
    containerExecutable: runtime.executable,
    executionIdentity: identity,
    datasetMounts: [f.mount],
    requireDatasetAccessProof: true,
    env: {
      HEPTA_OUTPUT_DIR: '/output',
      HEPTA_DATASET_AUTHORIZATION_SET_HASH: f.authorizationSet.datasetAuthorizationSetHash,
    },
  });
}

function forgedWorkerReceipt(receipt, mutate, { recomputeIdentity = true, recomputeEvidence = true } = {}) {
  const workerPayload = structuredClone(receipt);
  delete workerPayload.ok;
  delete workerPayload.receiptHash;
  delete workerPayload.blockers;
  const accessPayload = structuredClone(workerPayload.datasetAccessReceipt);
  delete accessPayload.datasetRuntimeAccessReceiptHash;
  mutate(accessPayload, workerPayload);
  const supervisor = accessPayload.supervisor;
  if (recomputeIdentity) supervisor.identityHash = hashRecord('ContainerDatasetAccessSupervisorIdentity', {
    protocol: supervisor.protocol, path: supervisor.path, supervisorSha256: supervisor.supervisorSha256,
    tracerSha256: supervisor.tracerSha256, setprivSha256: supervisor.setprivSha256,
    containerImageDigest: accessPayload.containerImageDigest, workloadUid: supervisor.workloadUid,
  });
  if (recomputeEvidence) supervisor.evidenceSha256 = hashBytes([
    'version=1', `protocol=${supervisor.protocol}`, `supervisor_sha256=${supervisor.supervisorSha256}`,
    `tracer_sha256=${supervisor.tracerSha256}`, `setpriv_sha256=${supervisor.setprivSha256}`,
    `trace_sha256=${accessPayload.traceSha256}`, `trace_bytes=${accessPayload.traceBytes}`,
    `trace_owner_uid=${supervisor.traceOwnerUid}`, `trace_owner_gid=${supervisor.traceOwnerGid}`,
    `workload_uid=${supervisor.workloadUid}`, `workload_gid=${supervisor.workloadGid}`,
    `workload_exit_code=${supervisor.workloadExitCode}`, '',
  ].join('\n'));
  workerPayload.datasetAccessSupervisorIdentityHash = supervisor.identityHash;
  workerPayload.datasetAccessReceipt = {
    ...accessPayload,
    datasetRuntimeAccessReceiptHash: hashRecord('DatasetRuntimeAccessReceipt', accessPayload),
  };
  return {
    ok: true, ...workerPayload,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', workerPayload),
    blockers: [],
  };
}

function academicHarnessFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-academic-supervisor-harness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const datasetRoot = path.join(root, 'dataset');
  const outputRoot = path.join(root, 'output');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(source); fs.mkdirSync(datasetRoot); fs.mkdirSync(outputRoot); fs.mkdirSync(runtimeRoot);
  fs.writeFileSync(path.join(datasetRoot, 'train.csv'), 'feature,label\n1,1\n');
  const inspection = inspectStrictDatasetManifest(datasetRoot, datasetRoot);
  assert.deepEqual(inspection.blockers, []);
  const benchmarkId = 'academic-supervisor-smoke';
  const seedSchedule = [17, 23, 31, 43];
  const minimumRepetitions = 8;
  const cells = seedSchedule.flatMap((seed) => Array.from({ length: minimumRepetitions }, (_, repetitionIndex) => ({
    seed,
    repetition: repetitionIndex + 1,
    cases: Array.from({ length: 8 }, (_, caseIndex) => {
      const primary = caseIndex < 4 ? -1 : 1;
      const secondary = repetitionIndex % 2 ? -0.2 : 0.2;
      const label = primary + (0.35 * secondary) >= 0 ? 1 : 0;
      return {
        caseId: hashRecord('AcademicSupervisorSmokeCase', { seed, repetition: repetitionIndex + 1, caseIndex }),
        input: { primary, secondary },
        ablationInput: { secondary },
        referenceResponse: 0,
        oracle: { label, robustLabel: label },
      };
    }),
  })));
  const definition = { version: 1, kind: 'OperatorAuthorizedDatasetBenchmarkHarness', benchmarkId, benchmarkFamily: 'ml_algorithm_benchmark', seedSchedule, minimumRepetitions, cells };
  const definitionHash = validateOperatorDatasetHarnessDefinition(definition, { benchmarkId }).operatorDatasetHarnessDefinitionHash;
  const splitManifest = {
    version: 1, kind: 'OperatorDatasetSplitManifest', datasetName: benchmarkId, datasetManifestHash: inspection.hash,
    entries: inspection.entries.filter((entry) => entry.type === 'file').map((entry) => ({ path: entry.relative, sha256: entry.hash, split: 'train' })),
  };
  const splitManifestHash = validateOperatorDatasetSplitManifest(splitManifest, { datasetName: benchmarkId, datasetManifestHash: inspection.hash }).operatorDatasetSplitManifestHash;
  const familyDesign = buildCampaignBenchmarkSelector({ benchmarkId: definition.benchmarkFamily, datasetMounts: [] }).experimentDesign;
  const builtAnalysisProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId,
    benchmarkFamily: definition.benchmarkFamily,
    requiredMetrics: familyDesign.requiredMetrics,
    metricSpecs: familyDesign.metricSpecs,
  });
  const { analysisProtocolHash, ...analysisProtocol } = builtAnalysisProtocol;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const authorityNow = new Date();
  const authoritySignedAt = new Date(authorityNow.getTime() - 60_000).toISOString();
  const authorityExpiresAt = new Date(authorityNow.getTime() + (24 * 60 * 60 * 1000)).toISOString();
  const authority = signAuthorityDocument({
    version: 2, kind: 'OperatorDatasetHarnessAuthority', datasetName: benchmarkId,
    datasetManifestHash: inspection.hash, datasetLicenseId: 'CC-BY-4.0', datasetSplitManifestHash: splitManifestHash,
    benchmarkHarnessDefinitionHash: definitionHash, benchmarkFamily: 'ml_algorithm_benchmark', seedSchedule, minimumRepetitions,
    analysisProtocolHash,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1', signedAt: authoritySignedAt, expiresAt: authorityExpiresAt,
  }, {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'academic-supervisor-key', role: 'dataset_harness_operator',
  });
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [{
    keyId: 'academic-supervisor-key', subjectId: 'academic-supervisor-operator', algorithm: 'ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), roles: ['dataset_harness_operator'], status: 'active',
  }] };
  const envelopePath = path.join(root, 'host-only-envelope.json');
  fs.writeFileSync(envelopePath, `${JSON.stringify({
    version: 2, kind: 'OperatorDatasetHarnessEnvelope', authority, splitManifest,
    harnessDefinition: definition, analysisProtocol,
  })}\n`, { mode: 0o600 });
  const mount = authorizeOperatorDatasetMount({ name: benchmarkId, source: datasetRoot, readOnly: true, manifestHash: inspection.hash, licenseId: 'CC-BY-4.0' }, {
    envelopePath, authorityTrustStore: trustStore, runtimeRoot, persistPrivateEnvelope: true, now: authorityNow,
  });
  const selector = buildCampaignBenchmarkSelector({ benchmarkId, datasetMounts: [mount] });
  const pythonAdapter = `import json,os,pathlib
pathlib.Path(os.environ['HEPTA_DATASET_ACADEMIC_SUPERVISOR_SMOKE']).joinpath('train.csv').read_bytes()
n=int(os.environ['HEPTA_BENCHMARK_CHALLENGE_PART_COUNT'])
challenge=json.loads(''.join(os.environ[f'HEPTA_BENCHMARK_CHALLENGE_JSON_PART_{i}'] for i in range(1,n+1)))
cells=[]
for cell in challenge['cells']:
 responses=[]
 for case in cell['challenge']['cases']:
  if challenge['arm']=='baseline': prediction=case['referenceResponse']
  elif challenge['arm']=='ablation': prediction=1 if case['input']['secondary']>=0 else 0
  else: prediction=1 if case['input']['primary']+(0.35*case['input']['secondary'])>=0 else 0
  responses.append({'caseId':case['caseId'],'prediction':prediction})
 cells.append({'cellId':cell['cellId'],'systemBenchmarkCellChallengeHash':cell['challenge']['systemBenchmarkCellChallengeHash'],'responses':responses})
pathlib.Path('/output/observation.json').write_text(json.dumps({'version':1,'kind':'CampaignBenchmarkArmBatchResponses','systemBenchmarkArmBatchChallengeHash':challenge['systemBenchmarkArmBatchChallengeHash'],'cells':cells})+'\\n')
`;
  const rAdapter = `readBin(file.path(Sys.getenv('HEPTA_DATASET_ACADEMIC_SUPERVISOR_SMOKE'), 'train.csv'), 'raw', n=1024)
n <- as.integer(Sys.getenv('HEPTA_BENCHMARK_CHALLENGE_PART_COUNT'))
parts <- vapply(seq_len(n), function(i) Sys.getenv(sprintf('HEPTA_BENCHMARK_CHALLENGE_JSON_PART_%d', i)), character(1))
challenge <- jsonlite::fromJSON(paste0(parts, collapse=''), simplifyVector=FALSE)
cells <- lapply(challenge$cells, function(cell) {
  responses <- lapply(cell$challenge$cases, function(case) {
    prediction <- if (challenge$arm == 'baseline') case$referenceResponse else if (challenge$arm == 'ablation') as.integer(case$input$secondary >= 0) else as.integer(case$input$primary + (0.35 * case$input$secondary) >= 0)
    list(caseId=case$caseId, prediction=prediction)
  })
  list(cellId=cell$cellId, systemBenchmarkCellChallengeHash=cell$challenge$systemBenchmarkCellChallengeHash, responses=responses)
})
jsonlite::write_json(list(version=1, kind='CampaignBenchmarkArmBatchResponses', systemBenchmarkArmBatchChallengeHash=challenge$systemBenchmarkArmBatchChallengeHash, cells=cells), '/output/observation.json', auto_unbox=TRUE)
`;
  for (const [entrypoint, adapter] of [['run.py', pythonAdapter], ['run.R', rAdapter]]) {
    fs.writeFileSync(path.join(source, entrypoint), adapter);
    const extension = path.extname(entrypoint);
    const base = entrypoint.slice(0, -extension.length);
    for (const arm of ['treatment', 'baseline', 'ablation']) fs.writeFileSync(path.join(source, `${base}.${arm}${extension}`), `# ${arm}\n${adapter}`);
  }
  return { source, datasetRoot, outputRoot, runtimeRoot, mount, selector, trustStore };
}

function academicHarnessWorkerRunner(f, runtime) {
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [runtime.executable], allowedRoots: [f.source], allowedOutputRoots: [f.outputRoot],
    allowedDatasetRoots: [f.datasetRoot], allowedContainerImages: [runtime.image],
    trustedDatasetSupervisorImages: [trustedProfile(runtime)],
    maximumTimeoutMs: 6 * 60 * 60 * 1000,
    maximumMemoryBytes: 4 * 1024 * 1024 * 1024,
    maximumCpuSeconds: 3600,
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', processLimit: { available: true, mechanism: 'docker-pids-cgroup' } },
  });
}

function rawArtifactWriteReceipt(harness, attemptId, role) {
  const payload = {
    version: 2,
    kind: 'ArtifactWriteReceipt',
    role: `campaign-experiment-raw-events:${role}`,
    path: `raw-events-${harness.rawEventArtifactHash.slice('sha256:'.length)}.ndjson`,
    hash: harness.rawEventArtifactHash,
    bytes: harness.rawEventArtifactBytes,
    contentType: 'application/octet-stream',
    contentAddress: harness.rawEventArtifactHash,
    immutableObject: true,
    atomic: true,
  };
  return Object.freeze({
    ...payload,
    writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload),
    ledgerReceiptId: `artifact-writes:${attemptId}`,
  });
}

function experimentRunFromExecution(execution, f, { attemptId, role, sourceLineageHash }) {
  const harness = execution.harnessExecutionReceipt;
  return buildExperimentRunReceipt({
    resultDocument: harness.resultDocument,
    csvDocument: harness.csvDocument,
    benchmarkSelector: f.selector,
    datasetMounts: [f.mount],
    executionReceiptHash: harness.systemBenchmarkHarnessExecutionReceiptHash,
    runtimeIdentityHash: harness.runtimeIdentityHash,
    sourceMerkleHash: harness.sourceMerkleHash,
    sourceWorkspaceManifestHash: harness.sourceWorkspaceManifestHash,
    cacheHit: false,
    resultJsonHash: harness.resultJsonHash,
    resultCsvHash: harness.resultCsvHash,
    experimentAttemptId: attemptId,
    harnessExecutionReceipt: harness,
    sourceLineageHash,
    rawArtifactWriteReceipt: rawArtifactWriteReceipt(harness, attemptId, role),
  });
}

function duplicateAcademicProcessIdentity(harnessReceipt) {
  const forged = structuredClone(harnessReceipt);
  const [source, target] = forged.armBatchExecutions;
  const previousBatchHash = target.systemBenchmarkArmBatchExecutionReceiptHash;
  target.runnerReceipt.executionProcessIdentity = structuredClone(source.runnerReceipt.executionProcessIdentity);
  target.runnerReceipt.executionProcessIdentityHash = source.runnerReceipt.executionProcessIdentityHash;
  const workerPayload = structuredClone(target.runnerReceipt);
  delete workerPayload.ok; delete workerPayload.receiptHash; delete workerPayload.blockers;
  target.runnerReceipt.receiptHash = hashRecord('OsSandboxWorkerReceipt', workerPayload);
  target.runnerReceiptHash = target.runnerReceipt.receiptHash;
  target.executionProcessIdentityHash = target.runnerReceipt.executionProcessIdentityHash;
  const batchPayload = structuredClone(target);
  delete batchPayload.systemBenchmarkArmBatchExecutionReceiptHash;
  target.systemBenchmarkArmBatchExecutionReceiptHash = hashRecord('SystemBenchmarkArmBatchExecutionReceipt', batchPayload);
  const cell = forged.cells.find((candidate) => candidate.armBatchExecutionReceiptHash === previousBatchHash);
  cell.armBatchExecutionReceiptHash = target.systemBenchmarkArmBatchExecutionReceiptHash;
  cell.systemBenchmarkArmProtocolExecutionReceiptHash = hashRecord('SystemBenchmarkArmProtocolExecutionReceipt', {
    cellId: cell.cellId,
    systemBenchmarkArmProtocolHash: cell.systemBenchmarkArmProtocolHash,
    systemBenchmarkArmAdapterHash: cell.armAdapter.sourceHash,
    armBatchExecutionReceiptHash: cell.armBatchExecutionReceiptHash,
    systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
    systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
    rawEventArtifactHash: cell.rawEventArtifactHash,
    rawEventCount: cell.rawEventCount,
    metrics: cell.metrics,
  });
  forged.processExecutionManifestHash = hashRecord('SystemBenchmarkProcessExecutionManifest', forged.armBatchExecutions.map((batch) => ({
    executionAttemptId: batch.executionAttemptId,
    executionProcessIdentityHash: batch.executionProcessIdentityHash,
    launcherPid: batch.runnerReceipt.executionProcessIdentity?.launcherPid || null,
    environmentBindingHash: batch.runnerReceipt.environmentBindingHash,
    cellIds: batch.cellIds,
  })));
  const harnessPayload = structuredClone(forged);
  delete harnessPayload.systemBenchmarkHarnessExecutionReceiptHash;
  forged.systemBenchmarkHarnessExecutionReceiptHash = hashRecord('SystemBenchmarkHarnessExecutionReceipt', harnessPayload);
  return forged;
}

test('dataset access rejects a mutable tag whose observed image digest changed', (t) => {
  const f = fixture(t);
  const receipt = runSpec(f, runnerFor(f, { resolvedDigest: OTHER_DIGEST }));
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.includes('worker_container_image_not_allowlisted'));
  assert.ok(receipt.blockers.includes('worker_dataset_access_container_supervisor_untrusted'));
  assert.ok(receipt.blockers.includes('worker_dataset_access_container_image_digest_mismatch'));
});

test('dataset access rejects missing and arbitrary supervisor profiles', (t) => {
  const f = fixture(t);
  const missing = runSpec(f, runnerFor(f, { trustedProfiles: [] }));
  assert.equal(missing.ok, false);
  assert.ok(missing.blockers.includes('worker_dataset_access_container_supervisor_untrusted'));

  const arbitraryImage = 'example.invalid/arbitrary-research-runtime:latest';
  const arbitrary = runSpec(f, runnerFor(f, {
    image: arbitraryImage,
    trustedProfiles: [{ ...trustedProfile(), image: arbitraryImage }],
  }), { image: arbitraryImage });
  assert.equal(arbitrary.ok, false);
  assert.ok(arbitrary.blockers.includes('worker_dataset_access_container_supervisor_untrusted'));
});

test('dataset access rejects a caller-forged execution capability', (t) => {
  const f = fixture(t);
  const runner = runnerFor(f);
  const issued = runner.resolveExecutionRuntimeIdentity({
    executable: 'python3',
    containerImage: AUTOMATION_RUNTIME_IMAGES.python.image,
    containerExecutable: 'python3',
  });
  const forged = { ...issued };
  const receipt = runSpec(f, runner, { executionIdentity: forged });
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.includes('worker_execution_identity_capability_invalid'));
});

test('system Python and R supervisors produce domain-verified v3 access receipts', { skip: !dockerImagesPresent }, (t) => {
  const f = fixture(t);
  const receipts = [];
  for (const [language, runtime] of [['python', AUTOMATION_RUNTIME_IMAGES.python], ['r', AUTOMATION_RUNTIME_IMAGES.r]]) {
    const outputDirectory = path.join(f.artifacts, language);
    fs.mkdirSync(outputDirectory);
    const runner = runnerFor(f, { runtime });
    const receipt = runSpec(f, runner, { runtime, outputDirectory });
    assert.equal(receipt.ok, true, `${language}:${JSON.stringify(receipt.blockers)}`);
    assert.equal(verifyOsSandboxWorkerReceipt(receipt), true);
    assert.equal(receipt.datasetAccessReceipt.version, 3);
    assert.equal(receipt.datasetAccessReceipt.status, 'dataset_runtime_access_verified');
    assert.equal(receipt.datasetAccessReceipt.datasets[0].readObserved, true);
    assert.equal(receipt.datasetAccessReceipt.readObservationAssurance,
      'positive-return-byte-observation-not-computational-use-proof-v1');
    assert.ok(receipt.datasetAccessReceipt.datasets[0].positiveReadBytesObserved > 0);
    assert.ok(receipt.datasetAccessReceipt.datasets[0].positiveReadObservationEventCount > 0);
    assert.match(receipt.datasetAccessReceipt.datasets[0].positiveReadObservationHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(receipt.datasetAccessSupervisorIdentityHash, /^sha256:[0-9a-f]{64}$/);
    const result = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'results.json'), 'utf8'));
    assert.deepEqual({ uid: result.uid, traceOverwriteDenied: result.traceOverwriteDenied, capEff: result.capEff }, {
      uid: 65532,
      traceOverwriteDenied: true,
      capEff: '0000000000000000',
    });
    receipts.push(receipt);
  }
  const [receipt] = receipts;

  const fake = `sha256:${'0'.repeat(64)}`;
  const forgeries = [
    forgedWorkerReceipt(receipt, (access) => { access.supervisor.supervisorSha256 = fake; }),
    forgedWorkerReceipt(receipt, (access) => { access.supervisor.tracerSha256 = fake; }),
    forgedWorkerReceipt(receipt, (access) => { access.supervisor.setprivSha256 = fake; }),
    forgedWorkerReceipt(receipt, (access, worker) => { access.containerImageDigest = fake; worker.containerImageDigest = fake; }),
    forgedWorkerReceipt(receipt, (access) => { access.supervisor.identityHash = fake; }, { recomputeIdentity: false }),
    forgedWorkerReceipt(receipt, (access) => { access.supervisor.evidenceSha256 = fake; }, { recomputeEvidence: false }),
  ];
  assert.ok(forgeries.every((forged) => verifyOsSandboxWorkerReceipt(forged) === false));
});

test('academic readiness requires real end-to-end probes for both pinned supervisor images', { skip: !dockerImagesPresent }, () => {
  const profiles = [AUTOMATION_RUNTIME_IMAGES.python, AUTOMATION_RUNTIME_IMAGES.r].map(trustedProfile);
  const probe = probeTrustedDockerDatasetSupervisors({ profiles, refresh: true });
  assert.equal(probe.available, true, JSON.stringify(probe));
  assert.equal(probe.results.length, 2);
  assert.ok(probe.results.every((result) => result.detail === 'trusted_dataset_supervisor_end_to_end_verified'));

  const mutable = probeTrustedDockerDatasetSupervisors({
    profiles: [{ ...profiles[0], imageDigest: OTHER_DIGEST }],
    refresh: true,
  });
  assert.equal(mutable.available, false);
  assert.match(mutable.detail, /profile_invalid|image_digest_mismatch/);
});

test('a timed-out trusted supervisor probe removes its created Docker container', () => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const calls = [];
  const containerId = 'a'.repeat(64);
  let cleanupAttempts = 0;
  let containerName = null;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'image' && args[1] === 'inspect') {
        return trustedDockerImageInspection(runtime);
      }
      if (args[0] === 'run') {
        containerName = args[args.indexOf('--name') + 1];
        const containerIdPath = args[args.indexOf('--cidfile') + 1];
        fs.writeFileSync(containerIdPath, `${containerId}\n`);
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        };
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        cleanupAttempts += 1;
        return cleanupAttempts < 3
          ? { status: 1, stdout: '', stderr: 'No such container' }
          : {
            status: 0,
            stdout: JSON.stringify([{
              Id: containerId,
              Name: `/${containerName}`,
              Created: new Date().toISOString(),
              Config: { Labels: {
                'io.hepta.probe.kind': 'trusted-dataset-supervisor',
                'io.hepta.probe.id': containerName,
              } },
            }]),
            stderr: '',
          };
      }
      if (args[0] === 'rm') return { status: 0, stdout: containerId, stderr: '' };
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  assert.equal(probe.available, false);
  assert.match(probe.detail, /ETIMEDOUT/);
  const run = calls.find(({ args }) => args[0] === 'run');
  assert.equal(run.options.timeout, 60_000);
  assert.equal(containerName, run.args[run.args.indexOf('--name') + 1]);
  assert.match(containerName, /^hepta-dataset-supervisor-probe-/);
  assert.equal(probe.results[0].cleanupStatus, 'confirmed_removed');
  assert.equal(cleanupAttempts, 3);
  assert.deepEqual(
    calls.find(({ args }) => args[0] === 'container').args,
    ['container', 'inspect', containerId],
  );
  assert.deepEqual(calls.at(-1).args, ['rm', '--force', containerId]);
  assert.equal(calls.at(-1).options.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), containerName)), false);
});

test('nonzero and thrown Docker run failures clean only their cid-bound container', () => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  for (const [index, mode] of ['nonzero', 'thrown'].entries()) {
    const containerId = String(index + 1).repeat(64);
    let containerName = null;
    let removed = false;
    const probe = probeTrustedDockerDatasetSupervisors({
      profiles: [trustedProfile(runtime)],
      refresh: true,
      environment: { PATH: process.env.PATH || '' },
      spawnSyncImpl(_executable, args) {
        if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'image') return trustedDockerImageInspection(runtime);
        if (args[0] === 'run') {
          containerName = args[args.indexOf('--name') + 1];
          const containerIdPath = args[args.indexOf('--cidfile') + 1];
          fs.writeFileSync(containerIdPath, `${containerId}\n`);
          if (mode === 'thrown') throw new Error('simulated_docker_transport_failure');
          return { status: 125, stdout: '', stderr: 'simulated_daemon_disconnect' };
        }
        if (args[0] === 'container') {
          assert.equal(args[2], containerId);
          return {
            status: 0,
            stdout: JSON.stringify([{
              Id: containerId,
              Name: `/${containerName}`,
              Created: new Date().toISOString(),
              Config: { Labels: {
                'io.hepta.probe.kind': 'trusted-dataset-supervisor',
                'io.hepta.probe.id': containerName,
              } },
            }]),
            stderr: '',
          };
        }
        if (args[0] === 'rm') { removed = true; return { status: 0, stdout: containerId }; }
        throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
      },
    });
    assert.equal(probe.results[0].cleanupStatus, 'confirmed_removed');
    assert.equal(removed, true);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), containerName)), false);
  }
});

test('a completed Docker failure accepts only repeated explicit container absence', () => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  let containerName = null;
  let inspectionCount = 0;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'image') return trustedDockerImageInspection(runtime);
      if (args[0] === 'run') {
        containerName = args[args.indexOf('--name') + 1];
        return { status: 125, stdout: '', stderr: 'simulated_create_failure' };
      }
      if (args[0] === 'container') {
        inspectionCount += 1;
        return { status: 1, stdout: '', stderr: 'Error: No such container' };
      }
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  assert.equal(inspectionCount, 5);
  assert.equal(probe.results[0].cleanupStatus, 'confirmed_absent');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), containerName)), false);
});

test('a failed cleanup inspection can never become confirmed absence', (t) => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  let containerName = null;
  let inspectionCount = 0;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'image') return trustedDockerImageInspection(runtime);
      if (args[0] === 'run') {
        containerName = args[args.indexOf('--name') + 1];
        return { status: 125, stdout: '', stderr: 'simulated_daemon_disconnect' };
      }
      if (args[0] === 'container') {
        inspectionCount += 1;
        return inspectionCount === 1
          ? {
            status: null, stdout: '', stderr: '',
            error: Object.assign(new Error('inspect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          }
          : { status: 1, stdout: '', stderr: 'Error: No such container' };
      }
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  t.after(() => fs.rmSync(path.join(os.tmpdir(), containerName), { recursive: true, force: true }));
  assert.equal(inspectionCount, 5);
  assert.equal(probe.results[0].cleanupStatus, 'unresolved');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), containerName)), true);
});

test('an owned container with exhausted remove attempts remains unresolved', (t) => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const containerId = '9'.repeat(64);
  let containerName = null;
  let removeCount = 0;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'image') return trustedDockerImageInspection(runtime);
      if (args[0] === 'run') {
        containerName = args[args.indexOf('--name') + 1];
        const containerIdPath = args[args.indexOf('--cidfile') + 1];
        fs.writeFileSync(containerIdPath, `${containerId}\n`);
        return { status: 125, stdout: '', stderr: 'simulated_daemon_disconnect' };
      }
      if (args[0] === 'container') {
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: containerId,
            Name: `/${containerName}`,
            Created: new Date().toISOString(),
            Config: { Labels: {
              'io.hepta.probe.kind': 'trusted-dataset-supervisor',
              'io.hepta.probe.id': containerName,
            } },
          }]),
        };
      }
      if (args[0] === 'rm') {
        removeCount += 1;
        return { status: 1, stdout: '', stderr: 'simulated_remove_failure' };
      }
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  t.after(() => fs.rmSync(path.join(os.tmpdir(), containerName), { recursive: true, force: true }));
  assert.equal(removeCount, 5);
  assert.equal(probe.results[0].cleanupStatus, 'unresolved');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), containerName)), true);
});

test('a timed-out probe never deletes a name collision without its ownership label', () => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  let containerName = null;
  let removeCount = 0;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'image') return trustedDockerImageInspection(runtime);
      if (args[0] === 'run') {
        containerName = args[args.indexOf('--name') + 1];
        return {
          status: null, stdout: '', stderr: '',
          error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        };
      }
      if (args[0] === 'container') {
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: 'b'.repeat(64),
            Name: `/${containerName}`,
            Config: { Labels: {
              'io.hepta.probe.kind': 'foreign-probe',
              'io.hepta.probe.id': containerName,
            } },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'rm') { removeCount += 1; return { status: 0 }; }
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  assert.equal(probe.results[0].cleanupStatus, 'ownership_mismatch');
  assert.equal(removeCount, 0);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), containerName)), false);
});

test('unresolved timeout evidence is preserved for a later cold-start reconciliation', (t) => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  let containerName = null;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'image') return trustedDockerImageInspection(runtime);
      if (args[0] === 'run') {
        containerName = args[args.indexOf('--name') + 1];
        return {
          status: null, stdout: '', stderr: '',
          error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        };
      }
      if (args[0] === 'container') {
        return { status: 1, stdout: '', stderr: 'No such container' };
      }
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  t.after(() => fs.rmSync(path.join(os.tmpdir(), containerName), { recursive: true, force: true }));
  assert.equal(probe.results[0].cleanupStatus, 'unresolved');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), containerName)), true);
});

test('cold-start reconciliation removes stale owned probe containers and workspaces', (t) => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const workspace = createDockerDatasetSupervisorProbeWorkspace();
  t.after(() => fs.rmSync(workspace.root, { recursive: true, force: true }));
  const containerName = path.basename(workspace.root);
  const containerId = 'c'.repeat(64);
  const stale = new Date(Date.now() - 180_000);
  fs.utimesSync(workspace.root, stale, stale);
  let removed = false;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: `${containerId}\n`, stderr: '' };
      if (args[0] === 'container') {
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: containerId,
            Name: `/${containerName}`,
            Created: stale.toISOString(),
            Config: { Labels: {
              'io.hepta.probe.kind': 'trusted-dataset-supervisor',
              'io.hepta.probe.id': containerName,
            } },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'rm') { removed = true; return { status: 0, stdout: containerId }; }
      if (args[0] === 'image') return { status: 1, stdout: '', stderr: 'blocked_after_reconcile' };
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  assert.equal(probe.available, false);
  assert.equal(removed, true);
  assert.equal(fs.existsSync(workspace.root), false);
});

test('cold-start reconciliation preserves a concurrent active owned probe workspace', (t) => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const workspace = createDockerDatasetSupervisorProbeWorkspace();
  t.after(() => fs.rmSync(workspace.root, { recursive: true, force: true }));
  const containerName = path.basename(workspace.root);
  const containerId = 'e'.repeat(64);
  const old = new Date(Date.now() - 180_000);
  fs.utimesSync(workspace.root, old, old);
  let removeCount = 0;
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: `${containerId}\n` };
      if (args[0] === 'container') {
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: containerId,
            Name: `/${containerName}`,
            Created: new Date().toISOString(),
            Config: { Labels: {
              'io.hepta.probe.kind': 'trusted-dataset-supervisor',
              'io.hepta.probe.id': containerName,
            } },
          }]),
        };
      }
      if (args[0] === 'rm') { removeCount += 1; return { status: 0 }; }
      if (args[0] === 'image') return { status: 1, stdout: '', stderr: 'stop_after_reconcile' };
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  assert.equal(probe.available, false);
  assert.equal(removeCount, 0);
  assert.equal(fs.existsSync(workspace.root), true);
});

test('cold-start reconciliation blocks when owned workspace removal cannot be verified', (t) => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const workspace = createDockerDatasetSupervisorProbeWorkspace();
  t.after(() => fs.rmSync(workspace.root, { recursive: true, force: true }));
  const containerName = path.basename(workspace.root);
  const containerId = 'f'.repeat(64);
  const stale = new Date(Date.now() - 180_000);
  fs.writeFileSync(workspace.ownershipPath, '{}\n', { mode: 0o600 });
  fs.utimesSync(workspace.root, stale, stale);
  const probe = probeTrustedDockerDatasetSupervisors({
    profiles: [trustedProfile(runtime)],
    refresh: true,
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(_executable, args) {
      if (args[0] === 'ps') return { status: 0, stdout: `${containerId}\n` };
      if (args[0] === 'container') {
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: containerId,
            Name: `/${containerName}`,
            Created: stale.toISOString(),
            Config: { Labels: {
              'io.hepta.probe.kind': 'trusted-dataset-supervisor',
              'io.hepta.probe.id': containerName,
            } },
          }]),
        };
      }
      if (args[0] === 'rm') return { status: 0, stdout: containerId };
      throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
    },
  });
  assert.equal(probe.available, false);
  assert.equal(probe.detail, 'trusted_dataset_supervisor_reconciliation_failed');
  assert.equal(fs.existsSync(workspace.root), true);
});

test('cold-start reconciliation fails closed on uninspectable or undated candidates', () => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const containerId = 'd'.repeat(64);
  const containerName = 'hepta-dataset-supervisor-probe-fixture';
  for (const mode of ['inspect_failed', 'created_invalid']) {
    let imageInspectionCount = 0;
    const probe = probeTrustedDockerDatasetSupervisors({
      profiles: [trustedProfile(runtime)],
      refresh: true,
      environment: { PATH: process.env.PATH || '' },
      spawnSyncImpl(_executable, args) {
        if (args[0] === 'ps') {
          return { status: 0, stdout: `${containerId}\n`, stderr: '' };
        }
        if (args[0] === 'container' && mode === 'inspect_failed') {
          return { status: 1, stdout: '', stderr: 'daemon_inspection_failed' };
        }
        if (args[0] === 'container') {
          return {
            status: 0,
            stdout: JSON.stringify([{
              Id: containerId,
              Name: `/${containerName}`,
              Created: 'not-a-date',
              Config: { Labels: {
                'io.hepta.probe.kind': 'trusted-dataset-supervisor',
                'io.hepta.probe.id': containerName,
              } },
            }]),
            stderr: '',
          };
        }
        if (args[0] === 'image') {
          imageInspectionCount += 1;
          return trustedDockerImageInspection(runtime);
        }
        throw new Error(`unexpected_docker_probe_command:${args.join(' ')}`);
      },
    });
    assert.equal(probe.available, false);
    assert.equal(probe.detail, 'trusted_dataset_supervisor_reconciliation_failed');
    assert.equal(imageInspectionCount, 0);
  }
});

test('academic-docker-operational: actual Python and R academic dataset harnesses execute all arms through the trusted supervisor', academicDockerOperationalOptions, (t) => {
  const f = academicHarnessFixture(t);
  const languageFilter = academicDockerOperationalMode === 'diagnostic'
    ? String(process.env.HEPTA_SUPERVISOR_TEST_LANGUAGE || '')
    : '';
  for (const [language, runtime, entrypoint] of [
    ['python', AUTOMATION_RUNTIME_IMAGES.python, 'run.py'],
    ['r', AUTOMATION_RUNTIME_IMAGES.r, 'run.R'],
  ].filter(([language]) => !languageFilter || language === languageFilter)) {
    const campaignId = `academic-supervisor-${language}-campaign`;
    const primaryNodeId = `${campaignId}:0:empirical`;
    const replayNodeId = `${campaignId}:0:empirical-reproduce`;
    const outputDirectory = path.join(f.outputRoot, language);
    fs.mkdirSync(outputDirectory);
    const workerRunner = academicHarnessWorkerRunner(f, runtime);
    const executor = createMultiLanguageEmpiricalExecutor({
      workerRunner,
      runtimeImages: { [language]: runtime },
      operatorDatasetAuthorityTrustStore: f.trustStore,
      runtimeRoot: f.runtimeRoot,
    });
    const sourceLineageHash = hashBytes(`academic-supervisor-${language}`);
    const execute = (role) => {
      const nodeId = role === 'primary' ? primaryNodeId : replayNodeId;
      const attemptId = `${campaignId}:${nodeId}:attempt-${role}`;
      const attemptOutput = path.join(outputDirectory, role);
      fs.mkdirSync(attemptOutput);
      return { attemptId, receipt: executor.execute({
        language, entrypoint, cwd: f.source, sourceRoot: f.source, outputDirectory: attemptOutput,
        outputPaths: ['results.json', 'results.csv'], datasetMounts: [f.mount], benchmarkSelector: f.selector,
        sourceLineageHash, cachePolicy: 'bypass',
        env: {
          HEPTA_EXPERIMENT_ATTEMPT_ID: attemptId,
          HEPTA_OUTPUT_DIR: '/output',
          HEPTA_DATASET_ACADEMIC_SUPERVISOR_SMOKE: '/datasets/academic-supervisor-smoke',
        },
      }) };
    };
    const original = execute('primary');
    const replay = execute('reproduction');
    for (const execution of [original, replay]) {
      const receipt = execution.receipt;
      assert.equal(receipt.status, 'empirical_execution_completed', `${language}:${JSON.stringify(receipt.blockers)}`);
      assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(receipt.harnessExecutionReceipt), true);
      assert.equal(receipt.harnessExecutionReceipt.executionIsolationMode, 'academic-per-cell-process-v1');
      assert.equal(receipt.harnessExecutionReceipt.processExecutionCount, receipt.harnessExecutionReceipt.scheduleCellCount);
      assert.equal(receipt.harnessExecutionReceipt.armBatchExecutions.length, receipt.harnessExecutionReceipt.scheduleCellCount);
      assert.equal(new Set(receipt.harnessExecutionReceipt.armBatchExecutions.map((batch) => batch.executionAttemptId)).size, receipt.harnessExecutionReceipt.scheduleCellCount);
      assert.equal(new Set(receipt.harnessExecutionReceipt.armBatchExecutions.map((batch) => batch.executionProcessIdentityHash)).size, receipt.harnessExecutionReceipt.scheduleCellCount);
      assert.equal(new Set(receipt.harnessExecutionReceipt.armBatchExecutions.map((batch) => batch.runnerReceipt.executionProcessIdentity.launcherPid)).size, receipt.harnessExecutionReceipt.scheduleCellCount);
      assert.equal(new Set(receipt.harnessExecutionReceipt.armBatchExecutions.map((batch) => batch.runnerReceipt.environmentBindingHash)).size, receipt.harnessExecutionReceipt.scheduleCellCount);
      const cellsById = new Map(receipt.harnessExecutionReceipt.cells.map((cell) => [cell.cellId, cell]));
      assert.ok(receipt.harnessExecutionReceipt.armBatchExecutions.every((batch) => (
        batch.scheduleCellCount === 1
        && batch.runnerReceipt.executionBindings.HEPTA_EXPERIMENT_SEED === String(cellsById.get(batch.cellIds[0]).seed)
        && batch.runnerReceipt.executionBindings.HEPTA_EXPERIMENT_REPETITION === String(cellsById.get(batch.cellIds[0]).repetition)
        && batch.runnerReceipt.executionBindings.HEPTA_HARNESS_CELL_ID === batch.cellIds[0]
        && batch.runnerReceipt.executionBindings.HEPTA_SEED === String(cellsById.get(batch.cellIds[0]).seed)
        && batch.runnerReceipt.executionBindings.PYTHONHASHSEED === String(cellsById.get(batch.cellIds[0]).seed)
        && batch.runnerReceipt.datasetAccessReceipt?.version === 3
        && batch.runnerReceipt.datasetAccessReceipt.status === 'dataset_runtime_access_verified'
        && verifyOsSandboxWorkerReceipt(batch.runnerReceipt)
      )));
    }
    const originalProcesses = new Set(original.receipt.harnessExecutionReceipt.armBatchExecutions.map((batch) => batch.executionProcessIdentityHash));
    assert.ok(replay.receipt.harnessExecutionReceipt.armBatchExecutions.every((batch) => !originalProcesses.has(batch.executionProcessIdentityHash)));
    assert.notEqual(original.receipt.harnessExecutionReceipt.environmentBindingHash, replay.receipt.harnessExecutionReceipt.environmentBindingHash);
    if (language === 'python') {
      assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(
        duplicateAcademicProcessIdentity(original.receipt.harnessExecutionReceipt),
      ), false, 'recomputed duplicate process identity must fail academic promotion');
    }
    const originalRun = experimentRunFromExecution(original.receipt, f, { attemptId: original.attemptId, role: 'primary', sourceLineageHash });
    const replayRun = experimentRunFromExecution(replay.receipt, f, { attemptId: replay.attemptId, role: 'reproduction', sourceLineageHash });
    assert.equal(verifyExperimentRunReceipt(originalRun), true);
    assert.equal(verifyExperimentRunReceipt(replayRun), true);
    const replayReceipt = buildExperimentReplayReceipt({ originalRunReceipt: originalRun, replayRunReceipt: replayRun });
    assert.equal(verifyExperimentReplayReceipt(replayReceipt), true, JSON.stringify(replayReceipt.blockers));
    const paperId = `academic-supervisor-${language}-paper`;
    const agendaRequest = buildAutonomousResearchAgendaProductionRequest({
      paperId,
      allowedProtocolFamilies: [f.selector.experimentDesign.benchmarkFamily],
    });
    const agentPayload = {
      version: 1,
      kind: 'AgentExecutionReceipt',
      status: 'agent_execution_completed',
      agentId: 'academic-supervisor-agenda-producer',
      providerMode: 'fixture-provider',
      resolvedModel: 'fixture-model',
      promptHash: hashRecord('AcademicSupervisorAgendaPrompt', { language }),
    };
    const agendaProducerReceipt = buildAutonomousResearchAgendaProductionReceipt({
      request: agendaRequest,
      selectedObjective: 'Evaluate the registered treatment against the signed baseline.',
      selectedProtocolFamily: f.selector.experimentDesign.benchmarkFamily,
      agentExecutionReceipt: {
        ...agentPayload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', agentPayload),
      },
      producerId: 'academic-supervisor-agenda-producer',
      generatedAt: '2026-07-22T00:00:00.000Z',
    });
    const researchAgendaIr = buildResearchAgendaIr({
      agendaProductionReceipt: agendaProducerReceipt,
      researchQuestion: 'Does the registered treatment improve the signed primary metric?',
      primaryClaim: 'The treatment is evaluated against the registered baseline.',
      dataRequirements: {
        population: 'Rows admitted by the signed dataset contract.',
        intervention: 'Registered treatment.',
        comparator: 'Registered baseline.',
        estimand: 'Paired primary-metric difference.',
        requiredVariables: ['feature', 'label'],
        datasetConstraints: ['read-only signed mount'],
      },
      falsifiers: ['A non-positive paired difference.'],
      negativeBoundaries: ['No population-wide causal claim.'],
      formalTargets: ['Check the aggregation invariant.'],
      priorArtQueryPlan: ['Search the registered treatment and estimand.'],
      venueConstraints: {
        paperType: 'research_article',
        requiredSections: ['methods', 'results', 'limitations'],
        artifactRequired: true,
        anonymousReviewRequired: true,
      },
      resourceFeasibility: {
        maximumWallTimeMs: 3_600_000,
        maximumMemoryBytes: 4_294_967_296,
        maximumCpuCount: 4,
        executionEnvironment: 'signed-docker-runtime-v1',
      },
    });
    const campaignPlanPayload = {
      version: 4,
      kind: 'PaperCampaignPlan',
      campaignId,
      paperId,
      executionIntent: {
        benchmarkSelectorHash: f.selector.campaignBenchmarkSelectorHash,
      },
      benchmarkSelector: f.selector,
      autonomousResearchPreparation: {
        researchAgendaProducerReceipt: agendaProducerReceipt,
        researchAgendaIr,
      },
    };
    const campaignPlanHash = hashRecord('PaperCampaignPlan', campaignPlanPayload);
    const campaignPlan = { ...campaignPlanPayload, campaignPlanHash };
    const authorityInput = {
      campaignId,
      paperId,
      campaignPlanHash,
      nodeId: replayNodeId,
      nodeKind: 'empirical-reproduce',
      researchAgendaIr,
      researchAgendaProducerReceipt: agendaProducerReceipt,
      experimentReplayReceipt: replayReceipt,
    };
    const executionAuthority = buildExperimentIrExecutionAuthorityReceipt(authorityInput);
    assert.equal(verifyExperimentIrExecutionAuthorityReceipt(
      executionAuthority, authorityInput,
    ), true);
    assert.equal(executionAuthority.originalVersionedExperimentIrHash,
      original.receipt.versionedExperimentIrHash);
    assert.equal(executionAuthority.replayVersionedExperimentIrHash,
      replay.receipt.versionedExperimentIrHash);
    assert.equal(verifyExperimentIrExecutionAuthorityReceipt(executionAuthority, {
      ...authorityInput,
      campaignId: `${campaignId}-other`,
    }), false);
    const persistedResult = {
      experimentIrExecutionAuthorityReceipt: executionAuthority,
      experimentIrExecutionAuthorityReceiptHash:
        executionAuthority.experimentIrExecutionAuthorityReceiptHash,
      experimentReplayReceipt: replayReceipt,
      experimentRunReceipt: replayRun,
      harnessExecutionReceipt: replay.receipt.harnessExecutionReceipt,
      experimentIr: replay.receipt.experimentIr,
      versionedExperimentIrHash: replay.receipt.versionedExperimentIrHash,
    };
    const persisted = inspectPersistedExperimentIrExecutionAuthority({
      store: { query: () => ({
        ok: true,
        rows: [{
          campaign_id: campaignId,
          paper_id: paperId,
          spec_json: JSON.stringify(campaignPlan),
          node_id: replayNodeId,
          node_kind: 'empirical-reproduce',
          node_status: 'completed',
          result_json: JSON.stringify(persistedResult),
          result_sha256: hashRecord('PaperCampaignNodeResult', persistedResult),
          node_updated_at: '2026-07-22T00:00:00.000Z',
        }],
      }) },
      agendaAuthorityInspection: {
        campaignId,
        paperId,
        campaignPlanHash,
        researchAgendaIr,
        researchAgendaProducerReceipt: agendaProducerReceipt,
      },
    });
    assert.equal(persisted.ready, true, JSON.stringify(persisted.blockers));
    assert.equal(persisted.receipt.experimentIrExecutionAuthorityReceiptHash,
      executionAuthority.experimentIrExecutionAuthorityReceiptHash);
    assert.equal(persisted.experimentHarnessExecutionReceipt
      .systemBenchmarkHarnessExecutionReceiptHash,
    executionAuthority.replaySystemBenchmarkHarnessExecutionReceiptHash);
  }
});

test('academic-docker-operational: academic per-cell execution fails closed after a partial process failure', academicDockerOperationalOptions, (t) => {
  const f = academicHarnessFixture(t);
  fs.writeFileSync(path.join(f.source, 'run.treatment.py'), `import os,pathlib
pathlib.Path(os.environ['HEPTA_DATASET_ACADEMIC_SUPERVISOR_SMOKE']).joinpath('train.csv').read_bytes()
raise SystemExit(7)
`);
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const outputDirectory = path.join(f.outputRoot, 'partial-failure');
  fs.mkdirSync(outputDirectory);
  const workerRunner = academicHarnessWorkerRunner(f, runtime);
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner, runtimeImages: { python: runtime }, operatorDatasetAuthorityTrustStore: f.trustStore, runtimeRoot: f.runtimeRoot,
  });
  const receipt = executor.execute({
    language: 'python', entrypoint: 'run.py', cwd: f.source, sourceRoot: f.source, outputDirectory,
    datasetMounts: [f.mount], benchmarkSelector: f.selector, sourceLineageHash: hashBytes('partial-failure'), cachePolicy: 'bypass',
    env: {
      HEPTA_EXPERIMENT_ATTEMPT_ID: 'academic-supervisor-partial-failure', HEPTA_OUTPUT_DIR: '/output',
      HEPTA_DATASET_ACADEMIC_SUPERVISOR_SMOKE: '/datasets/academic-supervisor-smoke',
    },
  });
  assert.equal(receipt.status, 'empirical_execution_failed');
  assert.equal(receipt.harnessExecutionReceipt.status, 'system_benchmark_harness_blocked');
  assert.ok(receipt.harnessExecutionReceipt.blockers.includes('benchmark_arm_batch_runner:treatment:os_sandbox_command_failed'));
  assert.ok(receipt.harnessExecutionReceipt.blockers.includes('benchmark_harness_process_execution_incomplete'));
  assert.equal(receipt.harnessExecutionReceipt.processExecutionCount, 0);
  assert.equal(verifySystemBenchmarkHarnessExecutionReceipt(receipt.harnessExecutionReceipt), false);
});
