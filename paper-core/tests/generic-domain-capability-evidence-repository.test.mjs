import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

import {
  genericDomainCapabilityEvidenceHash,
  genericDomainCapabilityEvidencePath,
  inspectGenericDomainCapabilityEvidence,
  publishGenericDomainCapabilityEvidence,
} from '../../paper-adapters/automation/generic-domain-capability-evidence-repository.mjs';
import {
  composeGenericDomainCapabilityEvidencePublication,
  inspectGenericDomainCapabilityEvidenceBindings,
} from '../../paper-composition/automation/generic-domain-capability-evidence-publication.mjs';
import {
  buildGenericDomainCapabilityEvidenceCandidate,
  composeStrongGenericDomainCapabilityEvidenceStatus,
  resolveFormalDomainQualificationEvidence,
} from '../../paper-composition/automation/generic-domain-capability-evidence-convergence.mjs';
import {
  inspectPersistedAutonomousResearchAssuranceAuthority,
} from '../../paper-composition/automation/automation-readiness-research-assurance-authority-inspection.mjs';
import {
  buildExternalResearchReplayRequest,
  verifyExternalResearchReplayRequest,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildFormalDomainQualificationExternalEvidence,
  verifyFormalDomainQualificationExternalEvidence,
} from '../../paper-domain/research/formal-domain-qualification-external-evidence.mjs';
import {
  REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
} from '../../paper-domain/research/formal-domain-profile-registry.mjs';

const evidence = Object.freeze({
  dynamicFormalExecutionAuthority: {},
  externalResearchReplayReceipt: {},
  externalResearchReplayRequest: {},
  experimentHarnessExecutionReceipt: {},
  experimentIrExecutionAuthorityReceipt: {},
  experimentReplayReceipt: {},
  formalDomainCoverageReceipt: {},
  formalDomainQualificationExternalEvidence: {},
  independentFormalReviewReceipt: {},
  priorArtClaimAlignmentReceipt: {},
  priorArtEvidenceReceipt: {},
  researchAgendaIr: {},
  venueProfile: {},
  venueRequirementIr: {},
});

function strongStatusFixture({
  paperId = 'paper-a',
  campaignId = 'campaign-a',
  persistedEvidence = null,
  candidate = null,
  semanticReady = true,
} = {}) {
  const campaignPlanHash = hashRecord('GenericStatusCampaignPlanFixture', {
    campaignId,
  });
  const dynamicFormalExecutionAuthority = Object.freeze({
    dynamicFormalExecutionAuthorityHash:
      hashRecord('GenericStatusFormalAuthorityFixture', { campaignId }),
  });
  const selectedEvidence = persistedEvidence || Object.freeze({
    ...evidence,
    dynamicFormalExecutionAuthority,
    experimentIrExecutionAuthorityReceipt: Object.freeze({
      campaignId,
      paperId,
      campaignPlanHash,
    }),
    externalResearchReplayReceipt: Object.freeze({ campaignId, paperId }),
    externalResearchReplayRequest: Object.freeze({ campaignId, paperId }),
    independentFormalReviewReceipt: Object.freeze({ campaignId, paperId }),
    priorArtClaimAlignmentReceipt: Object.freeze({ paperId }),
    researchAgendaIr: Object.freeze({ paperId }),
    venueRequirementIr: Object.freeze({ paperId }),
  });
  const selectedCandidate = candidate || selectedEvidence;
  const authority = Object.freeze({
    ready: true,
    campaignId,
    paperId,
    campaignPlanHash,
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    dynamicFormalExecutionAuthority,
    report: Object.freeze({
      genericDomainCapabilityReady: semanticReady,
      genericDomainCapabilityBlockers: semanticReady
        ? Object.freeze([])
        : Object.freeze(['generic_domain_capability_semantic_fixture_blocked']),
      genericDomainCapabilityEvidenceInspection: Object.freeze({
        ready: true,
        evidence: selectedEvidence,
        evidenceHash: genericDomainCapabilityEvidenceHash(selectedEvidence),
        blockers: Object.freeze([]),
      }),
      genericDomainCapabilityEvidenceCandidate: selectedCandidate,
      autonomousResearchAgendaAuthorityInspection: Object.freeze({
        ...authority,
        priorArtClaimAlignmentReady: true,
      }),
      experimentIrExecutionAuthorityInspection: authority,
      autonomousResearchVenueRequirementAuthorityInspection: authority,
      autonomousResearchAssuranceAuthorityInspection: authority,
    }),
  });
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-generic-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function spawnPublicationLockOwner(t, {
  runtimeRoot,
  acquiredAt,
  staleAfterMs,
  stayAlive,
}) {
  const lockPath = `${genericDomainCapabilityEvidencePath({ runtimeRoot })}.publish.lock`;
  const evidenceHash = genericDomainCapabilityEvidenceHash(evidence);
  const processIdentityModuleUrl = new URL(
    '../../workflow-kernel/runtime/process-identity.mjs',
    import.meta.url,
  ).href;
  const source = `
    import { randomUUID } from 'node:crypto';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    const { currentProcessIdentity } = await import(process.argv[6]);
    const [lockPath, evidenceHash, acquiredAt, staleAfterSource, stayAliveSource]
      = process.argv.slice(1, 6);
    const staleAfterMs = Number(staleAfterSource);
    const identity = currentProcessIdentity();
    const ownerNonce = randomUUID();
    let ownerBootIdentity = null;
    try {
      const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      ownerBootIdentity = value ? \`linux-boot:\${value}\` : null;
    } catch {}
    const record = {
      version: 1,
      kind: 'GenericDomainCapabilityEvidencePublicationLock',
      evidenceHash,
      ownerNonce,
      ownerPid: identity.pid,
      ownerPidStartTime: identity.pidStartTime,
      ownerHostname: os.hostname(),
      ownerBootIdentity,
      ownerUid: typeof process.getuid === 'function' ? process.getuid() : null,
      acquiredAt,
      staleAfterMs,
    };
    const ownerName = \`owner-\${ownerNonce}.json\`;
    const temporaryPath = path.join(
      path.dirname(lockPath),
      \`.generic-domain-capability-evidence.json.publish.lock.\${identity.pid}-\${ownerNonce}.tmp\`,
    );
    fs.mkdirSync(temporaryPath, { mode: 0o700 });
    const temporaryOwnerPath = path.join(temporaryPath, ownerName);
    const descriptor = fs.openSync(temporaryOwnerPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, \`\${JSON.stringify(record)}\\n\`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(temporaryPath, lockPath);
    process.stdout.write(\`\${JSON.stringify(record)}\\n\`);
    if (stayAliveSource === 'true') setInterval(() => {}, 60_000);
  `;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
    lockPath,
    evidenceHash,
    acquiredAt,
    String(staleAfterMs),
    String(stayAlive),
    processIdentityModuleUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exitPromise = once(child, 'exit');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `generic_domain_publication_lock_owner_timeout:${stderr}`,
    )), 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!stdout.includes('\n')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (stdout.includes('\n')) return;
      clearTimeout(timeout);
      reject(new Error(
        `generic_domain_publication_lock_owner_exited:${code}:${signal}:${stderr}`,
      ));
    });
  });
  const record = JSON.parse(stdout.split('\n')[0]);
  return Object.freeze({
    child,
    exitPromise,
    lockPath,
    ownerPath: path.join(lockPath, `owner-${record.ownerNonce}.json`),
    record,
  });
}

test('generic capability evidence is loaded only from the canonical private file', (t) => {
  const runtimeRoot = temporaryRoot(t);
  const evidencePath = genericDomainCapabilityEvidencePath({ runtimeRoot });
  fs.writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
  const inspection = inspectGenericDomainCapabilityEvidence({ runtimeRoot, environment: {} });
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.evidence, evidence);

  const otherPath = path.join(runtimeRoot, 'other.json');
  fs.writeFileSync(otherPath, JSON.stringify(evidence), { mode: 0o600 });
  const drift = inspectGenericDomainCapabilityEvidence({
    runtimeRoot,
    environment: { HEPTA_GENERIC_DOMAIN_CAPABILITY_EVIDENCE: otherPath },
  });
  assert.equal(drift.ready, false);
  assert.ok(drift.blockers.includes('generic_domain_capability_evidence_path_drift'));
});

test('strong generic status verifies authority, semantics, canonical hash, and lineage without returning evidence', () => {
  const fixture = strongStatusFixture();
  const status = composeStrongGenericDomainCapabilityEvidenceStatus({
    root: '/fixture/root',
    runtimeRoot: '/fixture/runtime',
    paperId: 'paper-a',
    environment: {},
    readinessQuery: () => ({ report: fixture.report }),
    currentFormalAuthorityAsserter: (authority) => ({ authority }),
  });
  assert.equal(status.ready, true);
  assert.equal(status.currentAuthorityReady, true);
  assert.equal(status.semanticReady, true);
  assert.equal(status.canonicalHashReady, true);
  assert.equal(status.paperBound, true);
  assert.equal(status.campaignBound, true);
  assert.equal(status.paperId, 'paper-a');
  assert.equal(status.campaignId, 'campaign-a');
  assert.equal(status.evidenceHash,
    fixture.report.genericDomainCapabilityEvidenceInspection.evidenceHash);
  assert.equal(Object.hasOwn(status, 'evidence'), false);
  assert.equal(Object.hasOwn(status, 'candidate'), false);
  assert.ok(JSON.stringify(status).length < 2_000);
});

test('strong generic status rejects each shape-only trust shortcut independently', () => {
  const fixture = strongStatusFixture();
  const common = {
    root: '/fixture/root',
    runtimeRoot: '/fixture/runtime',
    paperId: 'paper-a',
    environment: {},
    currentFormalAuthorityAsserter: (authority) => ({ authority }),
  };
  const staleAuthority = composeStrongGenericDomainCapabilityEvidenceStatus({
    ...common,
    readinessQuery: () => ({ report: fixture.report }),
    currentFormalAuthorityAsserter: () => {
      throw new Error('formal authority drifted');
    },
  });
  assert.equal(staleAuthority.ready, false);
  assert.equal(staleAuthority.currentAuthorityReady, false);

  const semantic = strongStatusFixture({ semanticReady: false });
  const semanticallyInvalid = composeStrongGenericDomainCapabilityEvidenceStatus({
    ...common,
    readinessQuery: () => ({ report: semantic.report }),
  });
  assert.equal(semanticallyInvalid.ready, false);
  assert.equal(semanticallyInvalid.semanticReady, false);

  const driftedCandidate = Object.freeze({
    ...fixture.report.genericDomainCapabilityEvidenceCandidate,
    venueProfile: Object.freeze({ injected: true }),
  });
  const canonical = strongStatusFixture({ candidate: driftedCandidate });
  const canonicallyDrifted = composeStrongGenericDomainCapabilityEvidenceStatus({
    ...common,
    readinessQuery: () => ({ report: canonical.report }),
  });
  assert.equal(canonicallyDrifted.ready, false);
  assert.equal(canonicallyDrifted.canonicalHashReady, false);

  const wrongPaper = composeStrongGenericDomainCapabilityEvidenceStatus({
    ...common,
    paperId: 'paper-b',
    readinessQuery: () => ({ report: fixture.report }),
  });
  assert.equal(wrongPaper.ready, false);
  assert.equal(wrongPaper.paperBound, false);

  const campaignDriftEvidence = Object.freeze({
    ...fixture.report.genericDomainCapabilityEvidenceInspection.evidence,
    externalResearchReplayReceipt: Object.freeze({
      campaignId: 'campaign-b',
      paperId: 'paper-a',
    }),
  });
  const campaign = strongStatusFixture({
    persistedEvidence: campaignDriftEvidence,
    candidate: campaignDriftEvidence,
  });
  const campaignDrifted = composeStrongGenericDomainCapabilityEvidenceStatus({
    ...common,
    readinessQuery: () => ({ report: campaign.report }),
  });
  assert.equal(campaignDrifted.ready, false);
  assert.equal(campaignDrifted.campaignBound, false);
});

test('missing, public, symlinked, and extra-field evidence fails closed', (t) => {
  const runtimeRoot = temporaryRoot(t);
  const evidencePath = genericDomainCapabilityEvidencePath({ runtimeRoot });
  assert.ok(inspectGenericDomainCapabilityEvidence({ runtimeRoot, environment: {} })
    .blockers.includes('generic_domain_capability_evidence_required'));

  fs.writeFileSync(evidencePath, JSON.stringify({ ...evidence, injected: true }), { mode: 0o644 });
  assert.equal(inspectGenericDomainCapabilityEvidence({ runtimeRoot, environment: {} }).ready, false);
  fs.chmodSync(evidencePath, 0o600);
  assert.ok(inspectGenericDomainCapabilityEvidence({ runtimeRoot, environment: {} })
    .blockers.includes('generic_domain_capability_evidence_shape_invalid'));

  fs.unlinkSync(evidencePath);
  const target = path.join(runtimeRoot, 'target.json');
  fs.writeFileSync(target, JSON.stringify(evidence), { mode: 0o600 });
  fs.symlinkSync(target, evidencePath);
  assert.ok(inspectGenericDomainCapabilityEvidence({ runtimeRoot, environment: {} })
    .blockers.includes('generic_domain_capability_evidence_not_private_regular_file'));
});

test('publication is durable, idempotent, and compare-and-swap protected', (t) => {
  const runtimeRoot = temporaryRoot(t);
  fs.chmodSync(runtimeRoot, 0o700);
  const first = publishGenericDomainCapabilityEvidence({ runtimeRoot, evidence });
  assert.equal(first.published, true);
  assert.equal(inspectGenericDomainCapabilityEvidence({ runtimeRoot, environment: {} }).ready, true);
  assert.equal(publishGenericDomainCapabilityEvidence({ runtimeRoot, evidence }).published, false);

  const replacement = Object.freeze({ ...evidence, venueProfile: { version: 2 } });
  assert.throws(() => publishGenericDomainCapabilityEvidence({
    runtimeRoot,
    evidence: replacement,
    expectedCurrentEvidenceHash: `sha256:${'0'.repeat(64)}`,
  }), /compare_and_swap_failed/);
  const replaced = publishGenericDomainCapabilityEvidence({
    runtimeRoot,
    evidence: replacement,
    expectedCurrentEvidenceHash: first.evidenceHash,
  });
  assert.equal(replaced.published, true);
});

test('publication fails closed while another publisher owns the evidence lock', (t) => {
  const runtimeRoot = temporaryRoot(t);
  fs.chmodSync(runtimeRoot, 0o700);
  const lockPath = `${genericDomainCapabilityEvidencePath({ runtimeRoot })}.publish.lock`;
  fs.writeFileSync(lockPath, 'other-publisher\n', { mode: 0o600 });
  assert.throws(() => publishGenericDomainCapabilityEvidence({ runtimeRoot, evidence }),
    /publication_in_progress/);
  assert.equal(fs.existsSync(genericDomainCapabilityEvidencePath({ runtimeRoot })), false);
});

test('publication reclaims an expired lock after its exact owner exits', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  fs.chmodSync(runtimeRoot, 0o700);
  const startedAt = new Date();
  const owner = await spawnPublicationLockOwner(t, {
    runtimeRoot,
    acquiredAt: startedAt.toISOString(),
    staleAfterMs: 1_000,
    stayAlive: false,
  });
  const [code, signal] = await owner.exitPromise;
  assert.equal(code, 0);
  assert.equal(signal, null);

  const result = publishGenericDomainCapabilityEvidence({
    runtimeRoot,
    evidence,
    clock: { now: () => new Date(startedAt.getTime() + 60_000) },
  });
  assert.equal(result.published, true);
  assert.equal(fs.existsSync(owner.lockPath), false);
  assert.equal(fs.existsSync(owner.ownerPath), false);
});

test('a crashed publication owner remains fenced until expiry and is then recovered', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  fs.chmodSync(runtimeRoot, 0o700);
  const startedAt = new Date();
  const owner = await spawnPublicationLockOwner(t, {
    runtimeRoot,
    acquiredAt: startedAt.toISOString(),
    staleAfterMs: 60_000,
    stayAlive: true,
  });
  assert.equal(owner.child.kill('SIGKILL'), true);
  const [code, signal] = await owner.exitPromise;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');

  assert.throws(() => publishGenericDomainCapabilityEvidence({
    runtimeRoot,
    evidence,
    clock: { now: () => new Date(startedAt.getTime() + 30_000) },
  }), /publication_in_progress/);
  assert.equal(fs.existsSync(owner.lockPath), true);

  const recovered = publishGenericDomainCapabilityEvidence({
    runtimeRoot,
    evidence,
    clock: { now: () => new Date(startedAt.getTime() + 120_000) },
  });
  assert.equal(recovered.published, true);
  assert.equal(fs.existsSync(owner.lockPath), false);
  assert.equal(fs.existsSync(owner.ownerPath), false);
});

test('an expired-looking lock owned by a live exact process is never removed', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  fs.chmodSync(runtimeRoot, 0o700);
  const startedAt = new Date();
  const owner = await spawnPublicationLockOwner(t, {
    runtimeRoot,
    acquiredAt: startedAt.toISOString(),
    staleAfterMs: 1,
    stayAlive: true,
  });
  const before = fs.lstatSync(owner.lockPath);
  const beforeOwner = fs.lstatSync(owner.ownerPath);
  const beforeSource = fs.readFileSync(owner.ownerPath, 'utf8');

  assert.throws(() => publishGenericDomainCapabilityEvidence({
    runtimeRoot,
    evidence,
    clock: { now: () => new Date(startedAt.getTime() + 60 * 60 * 1000) },
  }), /publication_in_progress/);
  const after = fs.lstatSync(owner.lockPath);
  const afterOwner = fs.lstatSync(owner.ownerPath);
  assert.equal(String(after.dev), String(before.dev));
  assert.equal(String(after.ino), String(before.ino));
  assert.equal(String(afterOwner.dev), String(beforeOwner.dev));
  assert.equal(String(afterOwner.ino), String(beforeOwner.ino));
  assert.equal(fs.readFileSync(owner.ownerPath, 'utf8'), beforeSource);

  assert.equal(owner.child.kill('SIGKILL'), true);
  await owner.exitPromise;
});

test('production publication rejects self-shaped evidence before any file mutation', (t) => {
  const runtimeRoot = temporaryRoot(t);
  fs.chmodSync(runtimeRoot, 0o700);
  const inspection = inspectGenericDomainCapabilityEvidenceBindings({
    evidence,
    researchAgendaProducerReceipt: {},
  });
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'generic_domain_capability_agenda_production_authority_invalid',
  ));
  assert.ok(inspection.blockers.includes(
    'generic_domain_capability_formal_coverage_external_replay_required',
  ));
  assert.throws(() => composeGenericDomainCapabilityEvidencePublication({
    runtimeRoot,
    evidence,
    researchAgendaProducerReceipt: {},
    environment: {},
  }), /generic_domain_capability_evidence_publication_blocked/);
  assert.equal(fs.existsSync(genericDomainCapabilityEvidencePath({ runtimeRoot })), false);
});

test('research assurance inspection requires current external replay, reviewer, and formal authorities before querying persisted claims', () => {
  let queried = false;
  const inspection = inspectPersistedAutonomousResearchAssuranceAuthority({
    store: { query: () => { queried = true; return { ok: true, rows: [] }; } },
    expectedAgendaAuthorityInspection: {
      ready: true,
      campaignId: 'campaign-a',
      paperId: 'paper-a',
      campaignPlanHash: `sha256:${'1'.repeat(64)}`,
      researchAgendaIr: { researchAgendaIrHash: `sha256:${'2'.repeat(64)}` },
    },
  });
  assert.equal(inspection.ready, false);
  assert.equal(queried, false);
  assert.ok(inspection.blockers.includes(
    'autonomous_research_assurance_current_authorities_required',
  ));
});

test('research assurance inspection requires the current experiment IR authority before querying persisted claims', () => {
  let queried = false;
  const inspection = inspectPersistedAutonomousResearchAssuranceAuthority({
    store: { query: () => { queried = true; return { ok: true, rows: [] }; } },
    expectedAgendaAuthorityInspection: {
      ready: true,
      campaignId: 'campaign-a',
      paperId: 'paper-a',
      campaignPlanHash: `sha256:${'1'.repeat(64)}`,
      researchAgendaIr: { researchAgendaIrHash: `sha256:${'2'.repeat(64)}` },
    },
    expectedExperimentIrExecutionAuthorityInspection: { ready: false },
    currentDynamicFormalExecutionAuthority: {},
    externalResearchReplayReceiptVerifier: {},
    reviewerReceiptVerificationAuthority: {},
  });
  assert.equal(inspection.ready, false);
  assert.equal(queried, false);
  assert.ok(inspection.blockers.includes(
    'autonomous_research_assurance_current_authorities_required',
  ));
});

test('unattended convergence rejects cross-campaign evidence before qualification publication', () => {
  const report = {
    genericDomainCapabilityEvidenceCandidate: evidence,
    autonomousResearchAgendaAuthorityInspection: {
      ready: true,
      priorArtClaimAlignmentReady: true,
      campaignId: 'campaign-a',
      paperId: 'paper-a',
      campaignPlanHash: `sha256:${'1'.repeat(64)}`,
    },
    experimentIrExecutionAuthorityInspection: {
      ready: true,
      campaignId: 'campaign-b',
      paperId: 'paper-a',
      campaignPlanHash: `sha256:${'1'.repeat(64)}`,
    },
    autonomousResearchVenueRequirementAuthorityInspection: {
      ready: true,
      campaignId: 'campaign-a',
      paperId: 'paper-a',
      campaignPlanHash: `sha256:${'1'.repeat(64)}`,
    },
    autonomousResearchAssuranceAuthorityInspection: {
      ready: true,
      campaignId: 'campaign-a',
      paperId: 'paper-a',
      campaignPlanHash: `sha256:${'1'.repeat(64)}`,
    },
  };
  assert.throws(() => buildGenericDomainCapabilityEvidenceCandidate({
    report,
    formalDomainCoverageReceipt: {},
  }), /generic_domain_convergence_campaign_lineage_mismatch/);
});

test('cold-start convergence qualifies formal domains before requesting independent external evidence', async () => {
  const order = [];
  const coverageReceipt = Object.freeze({ receipt: 'fresh-formal-domain-coverage' });
  const externalEvidence = Object.freeze({ receipt: 'external-replay-and-review' });
  const resolved = await resolveFormalDomainQualificationEvidence({
    coverageReceiptCurrent: false,
    qualificationRunner: async () => {
      order.push('formal-domain-qualification');
      return coverageReceipt;
    },
    externalEvidenceProducer: async ({ coverageReceipt: observed }) => {
      assert.equal(observed, coverageReceipt);
      order.push('external-replay-and-independent-review');
      return externalEvidence;
    },
    verifyExternalEvidence: (observedEvidence, observedCoverage) => (
      observedEvidence === externalEvidence && observedCoverage === coverageReceipt
    ),
  });
  assert.deepEqual(order, [
    'formal-domain-qualification',
    'external-replay-and-independent-review',
  ]);
  assert.equal(resolved.coverageReceipt, coverageReceipt);
  assert.equal(resolved.externalEvidence, externalEvidence);
  assert.equal(resolved.qualificationPerformed, true);
  assert.equal(resolved.externalQualificationPerformed, true);
});

test('external replay protocol admits formal-only qualification but never empty evidence', () => {
  const formalOnly = buildExternalResearchReplayRequest({
    paperId: 'formal-domain-production-qualification',
    campaignId: 'formal-domain-production-qualification',
    sourceSnapshotHash: hashRecord('FormalDomainCoverageFixture', { version: 1 }),
    experimentPairs: [],
    formalReplayReceiptHashes: [hashRecord('FormalReplayFixture', { profile: 'vector' })],
  });
  assert.deepEqual(formalOnly.experimentPairs, []);
  assert.equal(verifyExternalResearchReplayRequest(formalOnly), true);
  assert.throws(() => buildExternalResearchReplayRequest({
    paperId: 'formal-domain-production-qualification',
    campaignId: 'formal-domain-production-qualification',
    sourceSnapshotHash: hashRecord('FormalDomainCoverageFixture', { version: 1 }),
    experimentPairs: [],
    formalReplayReceiptHashes: [],
  }), /external_research_replay_request_invalid/);
});

test('formal-domain evidence requires its own external replay and signed independent review', () => {
  const profileEvidence = REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS.map((profileId) => ({
    profileId,
    formalProofSearchOperationReceiptHash:
      hashRecord('FormalDomainOperationFixture', { profileId }),
    replayExecutionReceiptHash: hashRecord('FormalDomainReplayFixture', { profileId }),
  }));
  const coverageReceipt = Object.freeze({
    formalDomainCoverageReceiptHash:
      hashRecord('FormalDomainCoverageFixture', { profileEvidence }),
    profileEvidence,
  });
  const externalReplayRequest = buildExternalResearchReplayRequest({
    paperId: 'formal-domain-production-qualification',
    campaignId: 'formal-domain-production-qualification',
    sourceSnapshotHash: coverageReceipt.formalDomainCoverageReceiptHash,
    experimentPairs: [],
    formalReplayReceiptHashes:
      profileEvidence.map((item) => item.replayExecutionReceiptHash),
  });
  const externalReplayReceipt = Object.freeze({
    version: 3,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    externalResearchReplayReceiptHash:
      hashRecord('ExternalFormalReplayFixture', { request: externalReplayRequest.requestHash }),
  });
  const signedReviewerReceipt = Object.freeze({
    version: 2,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    signedReviewerReceiptHash: hashRecord('SignedFormalDomainReviewerFixture', { version: 2 }),
  });
  const reviewerPayload = {
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    structuredOutput: {
      version: 1,
      kind: 'FormalDomainQualificationIndependentReview',
      status: 'approved',
      summary: 'All five exact profile obligations and fresh replays were reviewed.',
      blockers: [],
      formalDomainCoverageReceiptHash: coverageReceipt.formalDomainCoverageReceiptHash,
      externalReplayReceiptHash: externalReplayReceipt.externalResearchReplayReceiptHash,
      reviewedProfileIds: REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
      reviewedProfileEvidenceHashes:
        profileEvidence.map((item) => item.formalProofSearchOperationReceiptHash),
    },
    reviewerCryptographicAuthorityReady: true,
    reviewerIdentityIndependenceReady: true,
    signedReviewerReceiptHash: signedReviewerReceipt.signedReviewerReceiptHash,
    signedReviewerReceipt,
    unsignedAgentExecutionReceiptHash:
      hashRecord('UnsignedFormalDomainReviewerFixture', { version: 1 }),
    reviewPrincipalId: 'independent-formal-domain-reviewer',
    reviewPrincipalDescriptorHash: hashRecord('ReviewerDescriptorFixture', { version: 1 }),
    researchPrincipalPoolHash: hashRecord('ReviewerPoolFixture', { version: 1 }),
    reviewerSignerIdentityHash: hashRecord('ReviewerSignerFixture', { version: 1 }),
    reviewerTrustSetHash: hashRecord('ReviewerTrustFixture', { version: 1 }),
    reviewerSignatureVerificationPolicyHash:
      hashRecord('ReviewerPolicyFixture', { version: 1 }),
  };
  const formalDomainIndependentReviewAgentReceipt = Object.freeze({
    ...reviewerPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', reviewerPayload),
  });
  const externalResearchReplayReceiptVerifier = Object.freeze({
    kind: 'ExternalResearchReplayReceiptVerifier',
    verify: () => true,
  });
  const reviewerReceiptVerificationAuthority = Object.freeze({
    version: 2,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    researchPrincipalPoolHash: reviewerPayload.researchPrincipalPoolHash,
    reviewerTrustSetHash: reviewerPayload.reviewerTrustSetHash,
    reviewerSignatureVerificationPolicyHash:
      reviewerPayload.reviewerSignatureVerificationPolicyHash,
    verifySignedReviewerReceipt: () => true,
  });
  const dedicated = buildFormalDomainQualificationExternalEvidence({
    coverageReceipt,
    externalReplayRequest,
    externalReplayReceipt,
    formalDomainIndependentReviewAgentReceipt,
    externalResearchReplayReceiptVerifier,
    reviewerReceiptVerificationAuthority,
  });
  assert.equal(verifyFormalDomainQualificationExternalEvidence(dedicated, {
    coverageReceipt,
    externalResearchReplayReceiptVerifier,
    reviewerReceiptVerificationAuthority,
  }), true);
  assert.equal(verifyFormalDomainQualificationExternalEvidence({
    ...dedicated,
    formalDomainIndependentReviewAgentReceipt: {},
  }, {
    coverageReceipt,
    externalResearchReplayReceiptVerifier,
    reviewerReceiptVerificationAuthority,
  }), false);
});
