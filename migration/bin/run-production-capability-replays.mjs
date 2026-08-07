#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_CATALOG } from '../legacy-capability-matrix-v3.mjs';
import {
  capabilityConformanceReceiptHash,
  capabilityConformanceReplayEvidenceHash,
  capabilityConformanceReplayManifestHash,
  capabilityTargetBindings,
  capabilityVerificationCodeProvenanceHash,
  assertCapabilityVerificationCodeProvenanceUnchanged,
  assertProductionCapabilityRefreshCodeProvenance,
  createCapabilityReplayArtifactPublisher,
  resolveCurrentCapabilityProductionSubject,
  verifyCapabilityConformanceReceipt,
} from '../capability-operational-evidence.mjs';
import { buildClaimRegistry, transitionClaim } from '../../paper-domain/research/claim-registry.mjs';
import { buildResearchGapPlan, bindResearchGapPlan } from '../../paper-domain/research/gap-planner.mjs';
import { verifyEvidenceArtifact } from '../../paper-adapters/research-verify/evidence-verifier.mjs';
import { buildEvidenceIntake } from '../../paper-domain/research/evidence-ingestor.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { buildExperimentExecutionContract, buildExperimentOutputManifest } from '../../paper-domain/research/experiment-evidence-binding.mjs';
import { createLakeFormalVerifier } from '../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { createLeanToolchainIdentityProvider } from '../../paper-adapters/research-verify/lean-toolchain-identity.mjs';
import { resolvePinnedLakeExecutable } from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';
import { buildResearchChangeProposal } from '../../paper-domain/research/change-proposal.mjs';
import { createOsSandboxedWorkerRunner, probeOsSandbox } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { verifyArtifactWriteReceiptSource } from '../../paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueConformanceReplayWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { assertSubmissionExecutorPort, submissionExecutorDescriptor } from '../../paper-ports/submission-executor-port.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { buildSubmissionReleaseLock } from '../../paper-domain/submission/release-lock.mjs';
import { buildRepairApplyProof, rollbackAppliedPatches, validateAndMaybeApplyPatches } from '../../paper-adapters/referee-revise/repair-executor.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { sha256File } from '../../workflow-kernel/runtime/file-utils.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeRoot = defaultPaperRuntimeRoot();
const assetRoot = defaultPaperAssetRoot();
const paperId = 'A_Theory_of__Expectations';
const declaredPaperId = process.env.HEPTA_OPERATIONAL_REPLAY_PAPER_ID || null;
if (declaredPaperId !== null && declaredPaperId !== paperId) {
  throw new Error('production_capability_replay_canonical_paper_required');
}
const sourceRoot = path.join(assetRoot, 'submission', 'AoM', paperId);
const mainTex = path.join(sourceRoot, 'main.tex');
const privateKeyPath = process.env.HEPTA_CAPABILITY_OWNER_PRIVATE_KEY
  || path.join(os.homedir(), '.local', 'share', 'hepta-paper', 'capability-owner', 'capability-owner-ed25519-private.pem');
const trustStorePath = path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json');
const replayWorkParent = path.join(runtimeRoot, 'conformance-proof');
const fixedIso = '2026-07-13T05:45:00.000Z';
const clock = Object.freeze({ now: () => new Date(fixedIso), nowIso: () => fixedIso });

if (!process.argv.includes('--execute')) throw new Error('production-source conformance replays require --execute');
const inheritedReleaseCommit = process.env.HEPTA_RELEASE_COMMIT || null;
const codeProvenanceProvider = () => currentCodeProvenance({
  allowReleaseCommitEnvironment: false,
});
const codeProvenance = assertProductionCapabilityRefreshCodeProvenance({
  codeProvenance: codeProvenanceProvider(),
  declaredReleaseCommit: inheritedReleaseCommit,
});
const codeProvenanceHash = capabilityVerificationCodeProvenanceHash(codeProvenance);
const releaseCommit = codeProvenance.commit;
if (!fs.existsSync(mainTex)) throw new Error(`production replay subject missing: ${mainTex}`);
if (!fs.existsSync(privateKeyPath)) throw new Error('capability owner private key missing outside repository');
if (!fs.existsSync(trustStorePath)) throw new Error('owner trust store missing');
if (!releaseCommit) throw new Error('release commit missing');

process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'production_source_bound';
process.env.HEPTA_EVIDENCE_CLASS = 'conformance';

const trustStore = JSON.parse(fs.readFileSync(trustStorePath, 'utf8'));
const ownerKey = (trustStore.keys || []).find((item) => item?.status === 'active' && item?.roles?.includes('capability_owner'));
if (!ownerKey) throw new Error('active capability owner public key missing');
const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
const derivedPublic = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
if (String(derivedPublic).trim() !== String(ownerKey.publicKeyPem).trim()) throw new Error('capability owner private/public key mismatch');

const paperTask = Object.freeze({ paperId, taskKey: `paper:${paperId}`, sourceWorkspace: sourceRoot });
const productionSubject = resolveCurrentCapabilityProductionSubject({ assetRoot, paperId });
const mainTexHash = productionSubject.sourceHash;
const targetBindings = capabilityTargetBindings(workspaceRoot, CAPABILITY_CATALOG);
assertCapabilityVerificationCodeProvenanceUnchanged({
  expected: codeProvenance,
  actual: codeProvenanceProvider(),
  phase: 'preflight',
});

function assertProductionSubjectUnchanged(phase) {
  const current = resolveCurrentCapabilityProductionSubject({ assetRoot, paperId });
  if (JSON.stringify(current) !== JSON.stringify(productionSubject)) {
    throw new Error(`production_capability_replay_subject_changed:${phase}`);
  }
}

assertProductionSubjectUnchanged('preflight');

function seal(kind, payload, hashField = 'receiptHash') {
  return Object.freeze({ ...payload, version: payload.version || 1, kind, [hashField]: hashRecord(kind, { ...payload, version: payload.version || 1, kind }) });
}

function createReplayWorkRoot() {
  const runtimeStat = fs.lstatSync(runtimeRoot);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error('capability_replay_runtime_root_invalid');
  }
  try {
    fs.mkdirSync(replayWorkParent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const parentStat = fs.lstatSync(replayWorkParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('capability_replay_work_parent_invalid');
  }
  fs.chmodSync(replayWorkParent, 0o700);
  const root = fs.mkdtempSync(path.join(replayWorkParent, '.replay-work-'));
  fs.chmodSync(root, 0o700);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('capability_replay_work_root_invalid');
  }
  return Object.freeze({
    root,
    dev: stat.dev,
    ino: stat.ino,
    parentDev: parentStat.dev,
    parentIno: parentStat.ino,
  });
}

function removeOwnedReplayWorkRoot(replayWork) {
  const parentStat = fs.lstatSync(replayWorkParent);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.dev !== replayWork.parentDev
    || parentStat.ino !== replayWork.parentIno) {
    throw new Error('capability_replay_work_parent_identity_changed');
  }
  const stat = fs.lstatSync(replayWork.root);
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== replayWork.dev
    || stat.ino !== replayWork.ino) {
    throw new Error('capability_replay_work_root_identity_changed');
  }
  fs.rmSync(replayWork.root, { recursive: true, force: false });
  const parentFd = fs.openSync(
    replayWorkParent,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const openedParent = fs.fstatSync(parentFd);
    if (openedParent.dev !== replayWork.parentDev || openedParent.ino !== replayWork.parentIno) {
      throw new Error('capability_replay_work_parent_identity_changed');
    }
    fs.fsyncSync(parentFd);
  } finally {
    fs.closeSync(parentFd);
  }
}

let replayWork = null;
let replayWorkRoot = null;

function freshRoot(capabilityId) {
  const prefix = `${capabilityId.replace(/[^A-Za-z0-9_.-]/g, '_')}-`;
  const root = fs.mkdtempSync(path.join(replayWorkRoot, prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function createStore(root) {
  return createDefaultPaperStore({ root: assetRoot, runtimeRoot: root, dbPath: path.join(root, 'operational-replay.sqlite') });
}

function createLedger(store) {
  return createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueConformanceReplayWriter(),
  });
}

async function replayClaimRegistry() {
  const registry = buildClaimRegistry({
    paperTask,
    claims: [
      { id: 'operational-main-claim', text: `production-source:${mainTexHash}`, sourceLocator: 'main.tex#operational-main-claim' },
      { id: 'operational-dependent-claim', text: 'production-bound dependent claim', dependencyIds: ['operational-main-claim'], sourceLocator: 'main.tex#operational-dependent-claim' },
    ],
  });
  const transitioned = transitionClaim(registry, { claimId: 'operational-main-claim', toStatus: 'supported', expectedVersion: 1 });
  return { registryStatus: registry.status, registryHash: registry.claimRegistryHash, transitionedStatus: transitioned.claims[0].status, transitionedVersion: transitioned.claims[0].version, transitionStatus: transitioned.transitionReceipt.status };
}

async function replayGapPlanner(root) {
  const store = createStore(root);
  const ledger = createLedger(store, { writerId: 'operational-gap-planner', writerKind: 'job-receipt-store', allowedStreams: ['jobs', 'research-gap-jobs'] });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  const plan = buildResearchGapPlan({ paperTask, claimRegistry: { claims: [{ claimId: 'operational-main-claim', status: 'candidate' }] }, evidenceQualityGate: { coveredClaimIds: [] }, priorities: { 'operational-main-claim': 1 } });
  const binding = bindResearchGapPlan({ plan, jobReceiptStore: jobs, receiptLedger: ledger, clock, workerId: 'operational-gap-planner' });
  store.close?.();
  return { planHash: plan.researchGapPlanHash, planStatus: plan.status, jobCount: plan.jobs.length, bindingStatus: binding.status, persistedStatuses: binding.bindings.map((item) => item.persistedStatus).sort(), arbitraryCommandAllowed: plan.jobs.some((job) => job.arbitraryCommandAllowed === true) };
}

async function replayEvidenceIngestor(root) {
  const evidencePath = path.join(root, 'evidence.json');
  const bytes = Buffer.from(`${JSON.stringify({ paperId, mainTexHash, evidence: 'production-bound-operational-replay' })}\n`);
  await fsp.writeFile(evidencePath, bytes);
  const verified = await verifyEvidenceArtifact({ sourceRoot: root, evidence: { id: 'operational-evidence', path: 'evidence.json', hash: hashBytes(bytes), provenance: 'production_source_snapshot' } });
  const intake = buildEvidenceIntake({ nowMs: Date.parse(verified.createdAt), evidenceItems: [{ id: 'operational-evidence', claimIds: ['operational-main-claim'], path: 'evidence.json', hash: verified.verifiedHash, provenance: 'production_source_snapshot', verificationStatus: verified.status, verifiedHash: verified.verifiedHash, provenanceReceiptHash: verified.provenanceReceiptHash, createdAt: verified.createdAt, verificationReceipt: verified }] });
  return { verificationStatus: verified.status, verifiedHash: verified.verifiedHash, intakeStatus: intake.status, intakeItemCount: intake.items.length, sourceMutationPerformed: false };
}

async function replayEvidenceQualityGate() {
  const registry = buildClaimRegistry({ paperTask, claims: [{ id: 'operational-main-claim', text: `production-source:${mainTexHash}`, sourceLocator: 'main.tex#operational-main-claim', verificationPlan: { kind: 'artifact' } }] });
  const gate = buildEvidenceQualityGate({ paperTask, claimRegistry: registry, evidenceIntake: { status: 'evidence_intake_ready', items: [{ claimIds: ['operational-main-claim'], hash: mainTexHash, verifiedHash: mainTexHash, verificationStatus: 'evidence_artifact_verified', provenanceReceiptHash: hashRecord('ProductionSourceProvenance', { paperId, mainTexHash }), consumptionPolicy: { status: 'evidence_consumption_ready' } }] }, nativeWorkerReceipts: [] });
  return { registryStatus: registry.status, gateStatus: gate.status, coveredClaimIds: [...(gate.coveredClaimIds || [])].sort(), blockerCount: gate.blockers.length };
}

async function replayExperimentRegistry(root) {
  const store = createStore(root);
  const artifactLedger = createLedger(store, { writerId: 'operational-artifact-repository', writerKind: 'content-addressed-repository', allowedKinds: ['ArtifactWriteReceipt'], allowedStreams: ['artifact-writes'] });
  const repository = createFilesystemArtifactRepository({ scopeRoot: root, casRoot: path.join(root, 'cas'), repositoryId: 'operational-experiment-cas', receiptLedger: artifactLedger, clock });
  const experimentId = 'operational-experiment';
  const runId = 'production-replay-1';
  const datasetHash = mainTexHash;
  const codeHash = targetBindings['research.experiment-registry'][0].sha256;
  const seed = 1701;
  const resultReceipt = await repository.writeJson(path.join(root, 'result.json'), { paperId, mainTexHash, seed, metric: 1 }, { role: `experiment-result:${experimentId}:${runId}` });
  const outputNames = ['metrics.json', 'experiment-reproducibility.json'];
  const outputArtifacts = [];
  for (const name of outputNames) {
    const receipt = await repository.writeJson(path.join(root, name), { paperId, mainTexHash, seed, name }, { role: `experiment-output:${experimentId}:${runId}:${name}` });
    const { ledgerReceiptId, ...artifactWriteReceipt } = receipt;
    outputArtifacts.push({ name, artifactWriteReceipt, ledgerReceiptId });
  }
  const { ledgerReceiptId: resultLedgerReceiptId, ...resultArtifactWriteReceipt } = resultReceipt;
  const experiment = { experimentId, runId, datasetHash, datasetManifestHash: mainTexHash, datasetLicenseId: 'production-source-internal', datasetReadOnly: true, datasetMounts: [{ name: 'production-main-tex', manifestHash: mainTexHash, licenseId: 'production-source-internal', readOnly: true }], codeHash, resultHash: resultReceipt.hash, resultPath: 'result.json', seed, metric: 'operational_replay_equal', metricPredicates: [{ metric: 'operational_replay_equal', comparator: '==', threshold: 1 }], networkPolicy: 'none', secretsAllowed: false, externalActionsAllowed: false, providerCallsAllowed: false, sourceMutationAllowed: false, sourceReadOnlyRequired: true, ephemeralWorkRootRequired: true, separateOutputRootRequired: true };
  const executionContract = buildExperimentExecutionContract({ experiment, requiredOutputs: outputNames });
  const outputManifest = buildExperimentOutputManifest({ experimentId, runId, outputArtifacts: outputArtifacts.map((item) => ({ name: item.name, path: item.artifactWriteReceipt.path, hash: item.artifactWriteReceipt.hash, manifestHash: item.artifactWriteReceipt.manifestHash, writeReceiptHash: item.artifactWriteReceipt.writeReceiptHash })) });
  const isolationReceiptHash = hashRecord('OperationalExperimentIsolation', { paperId, mainTexHash, networkPolicy: 'none', sourceReadOnly: true });
  const workerLedger = createLedger(store, { writerId: 'operational-experiment-worker', writerKind: 'experiment-worker', allowedKinds: ['ExperimentWorkerExecutionReceipt'], allowedStreams: ['experiment-workers'] });
  const worker = seal('ExperimentWorkerExecutionReceipt', { status: 'worker_execution_completed', experimentId, runId, datasetHash, codeHash, resultHash: resultReceipt.hash, seed, executionContractHash: executionContract.experimentExecutionContractHash, datasetContractHash: executionContract.datasetContractHash, isolationPolicyHash: executionContract.isolationPolicyHash, metricPredicateContractHash: executionContract.metricPredicateContractHash, isolationReceiptHash, networkPolicy: 'none', secretAccessPerformed: false, externalActionPerformed: false, providerCallPerformed: false, sourceMutationDetected: false, sourceMerkleHashBefore: mainTexHash, sourceMerkleHashAfter: mainTexHash, isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true }, datasetMounts: experiment.datasetMounts, outputManifestHash: outputManifest.experimentOutputManifestHash, resultArtifactWriteReceiptHash: resultArtifactWriteReceipt.writeReceiptHash });
  const workerRecord = workerLedger.record(worker, { stream: 'experiment-workers', paperId });
  const workerReceipt = { ...worker, ledgerReceiptId: workerRecord.receiptId };
  const reproducibilityLedger = createLedger(store, { writerId: 'operational-experiment-reproducibility', writerKind: 'experiment-reproducibility-verifier', allowedKinds: ['ExperimentReproducibilityReceipt'], allowedStreams: ['experiment-reproducibility'] });
  const reproducibility = seal('ExperimentReproducibilityReceipt', { status: 'experiment_reproducibility_verified', experimentId, runId, seed, workerReceiptHash: worker.receiptHash, resultHash: resultReceipt.hash, outputArtifactHashes: outputArtifacts.map((item) => item.artifactWriteReceipt.hash).sort(), executionContractHash: executionContract.experimentExecutionContractHash, datasetContractHash: executionContract.datasetContractHash, isolationPolicyHash: executionContract.isolationPolicyHash, metricPredicateContractHash: executionContract.metricPredicateContractHash, isolationReceiptHash, outputManifestHash: outputManifest.experimentOutputManifestHash });
  const reproducibilityRecord = reproducibilityLedger.record(reproducibility, { stream: 'experiment-reproducibility', paperId });
  const artifact = { kind: 'experiment', ...experiment, requiredOutputs: outputNames, metrics: { operational_replay_equal: 1 }, workerReceipt, resultArtifact: { artifactWriteReceipt: resultArtifactWriteReceipt, ledgerReceiptId: resultLedgerReceiptId, outputArtifacts }, reproducibilityReceipt: { ...reproducibility, ledgerReceiptId: reproducibilityRecord.receiptId } };
  const registry = buildExperimentRegistry({ paperTask, artifacts: [artifact], receiptLedger: artifactLedger, artifactVerifier: verifyArtifactWriteReceiptSource });
  const result = { registryStatus: registry.status, experimentStatus: registry.experiments[0]?.status, executionContractHash: registry.experiments[0]?.evidenceBinding?.executionContractHash, datasetContractHash: registry.experiments[0]?.evidenceBinding?.datasetContractHash, isolationPolicyHash: registry.experiments[0]?.evidenceBinding?.isolationPolicyHash, metricPredicateContractHash: registry.experiments[0]?.evidenceBinding?.metricPredicateContractHash, trustedLedgerReceiptsVerified: registry.experiments[0]?.evidenceBinding?.trustedLedgerReceiptsVerified, artifactSourcesVerified: registry.experiments[0]?.evidenceBinding?.artifactSourcesVerified };
  store.close?.();
  return result;
}

async function replayFormalVerifier(root) {
  const projectRoot = path.join(root, 'formal-project');
  fs.cpSync(path.join(workspaceRoot, 'migration', 'fixtures', 'lean-adversarial'), projectRoot, { recursive: true });
  const commandRunner = {
    async run({ executable, args = [], cwd, timeoutMs = 120000 } = {}) {
      const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } });
      const payload = { version: 1, kind: 'ProductionFormalCommandReceipt', executable: path.basename(String(executable)), args: args.map(String), exitCode: result.status, stdoutHash: hashBytes(String(result.stdout || '')), stderrHash: hashBytes(String(result.stderr || result.error?.message || '')), externalActionPerformed: false };
      return { ok: result.status === 0 && !result.error, status: result.status === 0 && !result.error ? 'production_formal_command_passed' : 'production_formal_command_failed', stdout: String(result.stdout || ''), stderr: String(result.stderr || result.error?.message || ''), exitCode: result.status, receiptHash: hashRecord('ProductionFormalCommandReceipt', payload), isolation: { networkPolicy: 'none_by_operational_contract', sourceMutationPerformed: false, externalActionPerformed: false } };
    },
  };
  const pinnedRuntime = resolvePinnedLakeExecutable();
  if (pinnedRuntime.status !== 'formal_pinned_lake_resolved') throw new Error(pinnedRuntime.blockers.join(','));
  const verifier = createLakeFormalVerifier({
    projectRoot,
    commandRunner,
    executable: pinnedRuntime.lakeExecutable,
    toolchainIdentityProvider: createLeanToolchainIdentityProvider({
      toolchain: pinnedRuntime.toolchain,
      toolchainRoot: pinnedRuntime.toolchainRoot,
      leanExecutable: pinnedRuntime.leanExecutable,
      lakeExecutable: pinnedRuntime.lakeExecutable,
      expectedToolchainRootMerkleHash: pinnedRuntime.expectedToolchainRootMerkleHash,
      requiredOwnerUid: 0,
      requiredOwnerGid: 0,
      forbidGroupOrOtherWrite: true,
    }),
  });
  const certificate = await verifier.verify({ timeoutMs: 120000 });
  const replay = await verifier.replay({ certificateBundle: certificate });
  return { certificateStatus: certificate.status, replayStatus: replay.status, projectFiles: certificate.projectFiles?.map((item) => ({ path: item.path, hash: item.hash })).sort((a, b) => a.path.localeCompare(b.path)), toolchainHash: certificate.toolchainHash, manifestHash: certificate.manifestHash, externalActionPerformed: certificate.externalActionPerformed };
}

async function replayChangeProposal() {
  const proposal = buildResearchChangeProposal({ paperTask, patches: [{ preimageHash: mainTexHash, patchHash: hashRecord('OperationalNoopPatch', { paperId, mainTexHash }) }], evidenceQualityGate: { status: 'evidence_quality_ready' } });
  return { status: proposal.status, proposalHash: proposal.researchChangeProposalHash, sourceMutationPerformed: proposal.sourceMutationPerformed, applyAuthority: proposal.applyAuthority };
}

async function replaySandbox(root) {
  await fsp.writeFile(path.join(root, 'source.txt'), `${paperId}\n${mainTexHash}\n`);
  const probe = probeOsSandbox({ refresh: true });
  const runner = createOsSandboxedWorkerRunner({ allowedExecutables: ['/usr/bin/true'], allowedRoots: [root], probe });
  const receipt = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, outputPaths: [], timeoutMs: 120000 });
  if (receipt.status !== 'os_sandbox_worker_passed') throw new Error(`operational OS sandbox unavailable:${(receipt.blockers || []).join(',')}`);
  return { status: receipt.status, backend: receipt.backend, exitCode: receipt.exitCode, sourceMerkleHashBefore: receipt.sourceMerkleHashBefore, sourceMerkleHashAfter: receipt.sourceMerkleHashAfter, isolation: receipt.isolation, externalActionPerformed: receipt.externalActionPerformed };
}

async function replayArtifactRepository(root) {
  const store = createStore(root);
  const ledger = createLedger(store, { writerId: 'operational-artifact-repository', writerKind: 'content-addressed-repository', allowedKinds: ['ArtifactWriteReceipt'], allowedStreams: ['artifact-writes'] });
  const repository = createFilesystemArtifactRepository({ scopeRoot: root, casRoot: path.join(root, 'cas'), repositoryId: 'operational-artifact-cas', receiptLedger: ledger, clock });
  const receipt = await repository.writeJson(path.join(root, 'production-subject.json'), { paperId, mainTexHash }, { role: 'operational-capability-replay' });
  const verification = verifyArtifactWriteReceiptSource({ receipt });
  const manifest = await repository.readManifest(receipt.manifestHash);
  const result = { atomic: receipt.atomic, immutableObject: receipt.immutableObject, contentHash: receipt.hash, manifestHash: receipt.manifestHash, manifestContentHash: manifest.contentHash, sourceVerificationStatus: verification.status, externalActionPerformed: receipt.externalActionPerformed };
  store.close?.();
  return result;
}

async function replayJobReceiptStore(root) {
  const store = createStore(root);
  const ledger = createLedger(store, { writerId: 'operational-job-store', writerKind: 'job-receipt-store', allowedKinds: ['OperationalJobResultReceipt'], allowedStreams: ['jobs'] });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  const jobId = `operational-job:${paperId}`;
  jobs.createJob({ jobId, deduplicationKey: hashRecord('OperationalJobDeduplication', { paperId, mainTexHash }), kind: 'operational-capability-replay', paperId, environment: 'production', evidenceClass: 'operational' });
  const lease = jobs.acquireLease({ jobId, workerId: 'operational-worker' });
  const attempt = jobs.recordAttempt({ jobId, workerId: 'operational-worker', leaseGeneration: lease.leaseGeneration });
  const completed = jobs.completeJob({ jobId, attemptId: attempt.attemptId, workerId: 'operational-worker', leaseGeneration: attempt.leaseGeneration, receipt: seal('OperationalJobResultReceipt', { status: 'operational_job_completed', paperId, mainTexHash }, 'jobReceiptHash') });
  const result = { leaseStatus: lease.status, attemptId: attempt.attemptId, attemptNumber: attempt.attemptNumber, completedStatus: completed.status, attemptCount: completed.attemptCount, environment: completed.environment, evidenceClass: completed.evidence_class };
  store.close?.();
  return result;
}

async function replaySubmissionExecutorPort(root) {
  const executorId = 'operational-submission-executor';
  const capabilities = () => buildExecutorCapabilities({ executorId, sandboxModes: ['provider-workspace'], networkPolicy: 'provider-scoped', externalActions: true, workspaceIsolation: true, receiptKinds: ['SubmissionProviderReceipt'], provider: 'operational-dry-run-provider' });
  const executor = assertSubmissionExecutorPort({ executorId, provider: 'operational-dry-run-provider', accountId: 'operational-owner-account', workspaceRoot: path.join(root, 'external-provider-workspace'), externalWorkspace: true, capabilities, dispatch: ({ execute = false } = {}) => ({ status: execute ? 'external_execution_forbidden_in_replay' : 'provider_dispatch_dry_run_verified', externalActionPerformed: false }) });
  const descriptor = submissionExecutorDescriptor(executor);
  const dispatch = executor.dispatch({ execute: false });
  return { descriptorHash: descriptor.submissionExecutorDescriptorHash, capabilitiesHash: descriptor.capabilitiesHash, networkPolicy: descriptor.capabilities.networkPolicy, workspaceIsolation: descriptor.capabilities.workspaceIsolation, dispatchStatus: dispatch.status, externalActionPerformed: dispatch.externalActionPerformed };
}

async function replaySubmissionDelivery(root) {
  const store = createStore(root);
  const ledger = createLedger(store, { writerId: 'operational-submission-delivery', writerKind: 'submission-delivery-store', allowedKinds: ['SubmissionResponsePersistedReceipt'], allowedStreams: ['submission-delivery'] });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const dispatchAuthorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: hashRecord('OperationalSubmissionDispatch', { paperId, mainTexHash }), provider: 'operational-dry-run-provider', accountId: 'operational-owner-account', nonce: 'operational-nonce-1', attempt: 1 };
  const message = delivery.enqueue({ paperId, dispatchAuthorization, payload: { operationalReplay: true } });
  const response = { responseId: 'operational-response-1', outcome: 'failed', dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash, provider: dispatchAuthorization.provider, accountId: dispatchAuthorization.accountId, performedAt: fixedIso, attempt: 1 };
  const persisted = delivery.recordResponse({ messageId: message.message_id, response });
  const outbox = delivery.getOutbox(message.message_id);
  const consumption = delivery.getResponseConsumption(response.responseId);
  const duplicate = delivery.recordResponse({ messageId: message.message_id, response });
  const result = { persistedReceiptHash: persisted.receiptHash, duplicateReceiptHash: duplicate.receiptHash, sameReceipt: persisted.receiptHash === duplicate.receiptHash, outboxStatus: outbox.status, responseConsumptionState: consumption.state, recoverPendingCount: delivery.recoverPending().length };
  store.close?.();
  return result;
}

async function replaySubmissionReleaseLock() {
  const dispatchAuthorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: hashRecord('OperationalSubmissionDispatch', { paperId, mainTexHash }) };
  const responseIntake = { status: 'executor_response_accepted', outcome: 'failed', executorResponseIntakeHash: hashRecord('OperationalResponseIntake', { paperId, mainTexHash }), responseEnvelopeHash: hashRecord('OperationalResponseEnvelope', { paperId }), providerReceiptHash: null, submissionId: null };
  const reconciliation = { status: 'dry_run_reconciled', submissionReconciliationHash: hashRecord('OperationalDryRunReconciliation', { paperId, mainTexHash }) };
  const unlocked = buildSubmissionReleaseLock({ paperTask, dispatchAuthorization, responseIntake, reconciliation });
  const blocked = buildSubmissionReleaseLock({ paperTask });
  return { unlockedStatus: unlocked.status, unlockedHash: unlocked.submissionReleaseLockHash, missingEvidenceStatus: blocked.status, missingEvidenceBlockers: [...blocked.blockers].sort() };
}

async function replayRepairSafeApply(root) {
  const paperRoot = path.join(root, 'paper');
  await fsp.mkdir(paperRoot, { recursive: true });
  const target = path.join(paperRoot, 'main.tex');
  const patchPath = path.join(root, 'change.patch');
  await fsp.writeFile(target, `production-source:${mainTexHash}\n`);
  await fsp.writeFile(patchPath, ['diff --git a/paper/main.tex b/paper/main.tex', '--- a/paper/main.tex', '+++ b/paper/main.tex', '@@ -1 +1 @@', `-production-source:${mainTexHash}`, `+production-source:${mainTexHash} operational-replay`, ''].join('\n'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'operational-replay@example.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Hepta Operational Replay'], { cwd: root });
  spawnSync('git', ['add', 'paper/main.tex'], { cwd: root });
  const commit = spawnSync('git', ['commit', '-qm', 'operational baseline'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(commit.stderr || 'operational repair baseline commit failed');
  const preimageHash = await sha256File(target);
  const patchHash = await sha256File(patchPath);
  const row = { task: { paperId, sourceWorkspace: 'paper' } };
  const preimageSnapshotLedger = { preimageSnapshotLedgerHash: hashRecord('OperationalPreimageLedger', { paperId, preimageHash }), entries: [{ targetPath: 'paper/main.tex', exists: true, preimageHash }] };
  const execution = { plannedPatchInputs: [{ patchId: 'operational-change', patchPath: 'change.patch', patchSha256: patchHash, targetPaths: ['paper/main.tex'] }] };
  const dryRun = await validateAndMaybeApplyPatches({ root, row, patchApplyExecution: execution, preimageSnapshotLedger, execute: false });
  const applied = await validateAndMaybeApplyPatches({ root, row, patchApplyExecution: execution, preimageSnapshotLedger, execute: true });
  const proof = buildRepairApplyProof({ row, preimageSnapshotLedger, patchApplyResult: applied });
  const rollback = await rollbackAppliedPatches({ root, row, patchApplyResult: applied });
  const restoredHash = await sha256File(target);
  return { dryRunBlockerCount: dryRun.blockers.length, cleanApplyCheck: dryRun.validationRecords[0]?.cleanApplyCheck, applied: applied.applied, proofStatus: proof.status, rollbackStatus: rollback.status, restoredHash, preimageHash, sourceRestored: restoredHash === preimageHash };
}

const replayByCapability = Object.freeze({
  'research.claim-registry': (_root) => replayClaimRegistry(),
  'research.gap-planner': replayGapPlanner,
  'research.evidence-ingestor': replayEvidenceIngestor,
  'research.evidence-quality-gate': (_root) => replayEvidenceQualityGate(),
  'research.experiment-registry': replayExperimentRegistry,
  'research.formal-verifier': replayFormalVerifier,
  'research.change-proposal': (_root) => replayChangeProposal(),
  'runtime.sandboxed-worker-runner': replaySandbox,
  'runtime.artifact-repository': replayArtifactRepository,
  'runtime.job-receipt-store': replayJobReceiptStore,
  'submission.executor-port': replaySubmissionExecutorPort,
  'submission.delivery-runtime': replaySubmissionDelivery,
  'submission.release-lock': (_root) => replaySubmissionReleaseLock(),
  'repair.safe-apply': replayRepairSafeApply,
});

const verified = [];
const publication = createCapabilityReplayArtifactPublisher({
  runtimeRoot,
  publicationId: `${releaseCommit.slice(0, 12)}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
});
const publicationOrder = [];
try {
  replayWork = createReplayWorkRoot();
  replayWorkRoot = replayWork.root;
  for (const capabilityId of Object.keys(CAPABILITY_CATALOG).sort()) {
    const executeReplay = replayByCapability[capabilityId];
    if (!executeReplay) throw new Error(`operational replay missing:${capabilityId}`);
    const first = await executeReplay(freshRoot(capabilityId));
    const firstHash = hashRecord('CapabilityOperationalResult', { capabilityId, result: first });
    const second = await executeReplay(freshRoot(capabilityId));
    const secondHash = hashRecord('CapabilityOperationalResult', { capabilityId, result: second });
    const replayMatched = firstHash === secondHash;
    if (!replayMatched) throw new Error(`operational replay mismatch:${capabilityId}`);
    const inputHashes = [mainTexHash, hashRecord('CapabilityOperationalReplayInput', { capabilityId, paperId, mainTexHash })];
    const comparison = { version: 1, kind: 'CapabilityOperationalReplayComparison', capabilityId, firstResultHash: firstHash, secondResultHash: secondHash, replayMatched };
    const replayReceiptHash = hashRecord('CapabilityOperationalReplayComparison', comparison);
    const evidencePayload = { version: 2, kind: 'CapabilityConformanceReplayEvidence', capabilityId, status: 'production_source_bound_conformance_replay_verified', executionClass: 'production_source_bound_conformance', productionSubject, inputHashes, targetHashes: targetBindings[capabilityId], firstResult: first, secondResult: second, resultHash: firstHash, replayReceiptHash, replayMatched, releaseCommit, codeProvenance, codeProvenanceHash, evidenceEnvironment: 'production_source_bound', evidenceClass: 'conformance', productionEligible: false, externalActionPerformed: false, createdAt: new Date().toISOString() };
    const executionReceiptHash = capabilityConformanceReplayEvidenceHash(evidencePayload);
    const evidence = { ...evidencePayload, executionReceiptHash };
    const evidenceRelativePath = `replays/${capabilityId}/${releaseCommit.slice(0, 12)}.json`;
    const evidenceStaging = publication.stageJson(evidenceRelativePath, evidence);
    publicationOrder.push(evidenceRelativePath);
    const unsignedReceipt = { version: 2, kind: 'CapabilityConformanceReceipt', capabilityId, status: 'production_source_bound_conformance_replay_verified', executionClass: 'production_source_bound_conformance', evidenceEnvironment: 'production_source_bound', evidenceClass: 'conformance', productionEligible: false, issuerAssurance: 'local_admin_delegated', productionSubject, inputHashes, executionReceiptHash, resultHash: firstHash, replayReceiptHash, replayMatched, releaseCommit, codeProvenance, codeProvenanceHash, targetHashes: targetBindings[capabilityId], executionEvidencePath: evidenceStaging.runtimeRelativePath, externalActionPerformed: false, signatures: [] };
    let receipt = {
      ...unsignedReceipt,
      capabilityConformanceReceiptHash: capabilityConformanceReceiptHash(unsignedReceipt),
    };
    receipt = signAuthorityDocument(receipt, { privateKeyPem, keyId: ownerKey.keyId, role: 'capability_owner' });
    const receiptRelativePath = `capabilities/${capabilityId}/${releaseCommit.slice(0, 12)}.json`;
    const receiptStaging = publication.stageJson(receiptRelativePath, receipt);
    publicationOrder.push(receiptRelativePath);
    const verification = verifyCapabilityConformanceReceipt({ document: receipt, trustStore, capabilityId, targetBindings: targetBindings[capabilityId], releaseCommit, codeProvenance, expectedProductionSubject: productionSubject });
    if (verification.status !== 'capability_conformance_receipt_verified') throw new Error(`conformance receipt verification failed:${capabilityId}:${verification.blockers.join(',')}`);
    verified.push({ capabilityId, resultHash: firstHash, executionReceiptHash, replayReceiptHash, conformanceReceiptHash: verification.conformanceReceiptHash, receiptPath: receiptStaging.runtimeRelativePath, evidencePath: evidenceStaging.runtimeRelativePath });
  }

  const manifestPayload = { version: 2, kind: 'CapabilityConformanceReplayManifest', status: 'all_capabilities_conformance_replayed', releaseCommit, codeProvenance, codeProvenanceHash, paperId, productionSourceHash: mainTexHash, productionSubject, inputHashes: [mainTexHash], capabilityCount: verified.length, issuerAssurance: 'local_admin_delegated', productionEligible: false, verified, externalActionPerformed: false, completedAt: new Date().toISOString() };
  const manifest = { ...manifestPayload, capabilityConformanceReplayManifestHash: capabilityConformanceReplayManifestHash(manifestPayload) };
  const manifestRelativePath = `CAPABILITY_CONFORMANCE_REPLAY_MANIFEST_${releaseCommit.slice(0, 12)}.json`;
  publication.stageJson(manifestRelativePath, manifest);
  publicationOrder.push(manifestRelativePath);
  assertCapabilityVerificationCodeProvenanceUnchanged({
    expected: codeProvenance,
    actual: codeProvenanceProvider(),
    phase: 'postflight',
  });
  assertProductionSubjectUnchanged('postflight');
  await publication.publish({
    relativePaths: publicationOrder,
    beforePublish() {
      assertCapabilityVerificationCodeProvenanceUnchanged({
        expected: codeProvenance,
        actual: codeProvenanceProvider(),
        phase: 'prepublication',
      });
      assertProductionSubjectUnchanged('prepublication');
    },
    afterPublish() {
      assertCapabilityVerificationCodeProvenanceUnchanged({
        expected: codeProvenance,
        actual: codeProvenanceProvider(),
        phase: 'postpublication',
      });
      assertProductionSubjectUnchanged('postpublication');
    },
  });
  process.stdout.write(`${JSON.stringify({ status: manifest.status, capabilityCount: manifest.capabilityCount, paperId, productionSourceHash: mainTexHash, manifestHash: manifest.capabilityConformanceReplayManifestHash, conformanceReceiptHashes: verified.map((item) => item.conformanceReceiptHash), productionEligible: false }, null, 2)}\n`);
} finally {
  try {
    publication.discard();
  } finally {
    if (replayWork) removeOwnedReplayWorkRoot(replayWork);
  }
}
