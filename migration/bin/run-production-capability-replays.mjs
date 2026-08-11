#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { buildResearchChangeProposal } from '../../paper-domain/research/change-proposal.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { verifyArtifactWriteReceiptSource } from '../../paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueConformanceReplayWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createFormalCapabilityReplayRunners } from './production-capability-replay-formal-runners.mjs';
import { createRuntimeCapabilityReplayRunners } from './production-capability-replay-runtime-runners.mjs';
import { createSubmissionRepairCapabilityReplayRunners } from './production-capability-replay-submission-repair-runners.mjs';

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

function privateFileIdentity(stat) {
  return JSON.stringify({
    dev: stat.dev,
    gid: stat.gid,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
  });
}

function readCapabilityOwnerPrivateKey(selectedPath) {
  const selected = path.resolve(String(selectedPath || ''));
  if (!path.isAbsolute(String(selectedPath || ''))
    || selected !== selectedPath
    || fs.realpathSync(selected) !== selected
    || selected === workspaceRoot
    || selected.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error('capability owner private key path invalid');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || before.uid !== process.getuid() || before.gid !== process.getgid()
      || (before.mode & 0o7777) !== 0o600
      || before.size < 64 || before.size > 16 * 1024) {
      throw new Error('capability owner private key file invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (privateFileIdentity(before) !== privateFileIdentity(after)
      || bytes.length !== before.size) {
      throw new Error('capability owner private key changed during read');
    }
    return bytes.toString('utf8');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

if (!process.argv.includes('--execute')) throw new Error('production-source conformance replays require --execute');
process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'production_source_bound';
process.env.HEPTA_EVIDENCE_CLASS = 'conformance';
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
if (!fs.existsSync(trustStorePath)) throw new Error('owner trust store missing');
if (!releaseCommit) throw new Error('release commit missing');

const trustStore = JSON.parse(fs.readFileSync(trustStorePath, 'utf8'));
const ownerKey = (trustStore.keys || []).find((item) => item?.status === 'active' && item?.roles?.includes('capability_owner'));
if (!ownerKey) throw new Error('active capability owner public key missing');
let privateKeyPem;
try {
  privateKeyPem = readCapabilityOwnerPrivateKey(privateKeyPath);
} catch (error) {
  throw new Error(`capability owner private key unavailable:${error.message}`);
}
const privateKey = crypto.createPrivateKey(privateKeyPem);
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('capability owner private key must be Ed25519');
}
const derivedPublic = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
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

async function replayChangeProposal() {
  const proposal = buildResearchChangeProposal({ paperTask, patches: [{ preimageHash: mainTexHash, patchHash: hashRecord('OperationalNoopPatch', { paperId, mainTexHash }) }], evidenceQualityGate: { status: 'evidence_quality_ready' } });
  return { status: proposal.status, proposalHash: proposal.researchChangeProposalHash, sourceMutationPerformed: proposal.sourceMutationPerformed, applyAuthority: proposal.applyAuthority };
}

const replayByCapability = Object.freeze({
  'research.claim-registry': (_root) => replayClaimRegistry(),
  'research.gap-planner': replayGapPlanner,
  'research.evidence-ingestor': replayEvidenceIngestor,
  'research.evidence-quality-gate': (_root) => replayEvidenceQualityGate(),
  'research.experiment-registry': replayExperimentRegistry,
  ...createFormalCapabilityReplayRunners({ workspaceRoot }),
  'research.change-proposal': (_root) => replayChangeProposal(),
  ...createRuntimeCapabilityReplayRunners({
    clock,
    createLedger,
    createStore,
    mainTexHash,
    paperId,
    seal,
  }),
  ...createSubmissionRepairCapabilityReplayRunners({
    clock,
    createLedger,
    createStore,
    fixedIso,
    mainTexHash,
    paperId,
    paperTask,
  }),
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
