import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import { executeAutonomousResearchCampaign } from '../../paper-application/automation/autonomous-research-campaign.mjs';
import { preflightAutonomousEmpiricalRuntimes } from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  createExternalResearchQualificationProcessAdapter,
  inspectExternalResearchQualificationProcessConfiguration,
  verifyExternalQualificationReleaseSignerAuthority,
} from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import {
  readExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
  fullResearchQualificationSigningPayloadHash,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import { createAutonomousResearchReleaseBinding } from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';

const H = (label) => hashRecord('AutonomousExternalQualificationTestHash', { label });

const READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION =
  preflightAutonomousEmpiricalRuntimes({
    spawnSyncImpl(_command, args) {
      const runtime = [AUTOMATION_RUNTIME_IMAGES.python, AUTOMATION_RUNTIME_IMAGES.r]
        .find((candidate) => candidate.image === args[2]);
      return {
        status: runtime ? 0 : 1,
        stdout: runtime ? JSON.stringify([{
          Id: `sha256:${'f'.repeat(64)}`,
          Descriptor: {
            digest: runtime.imageDigest,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
          },
          Os: 'linux',
          Architecture: 'amd64',
        }]) : '',
      };
    },
  });

function memoryQualificationStateStore({ read, write }) {
  return Object.freeze({
    kind: 'AutonomousResearchQualificationStateRepository',
    durable: true,
    compareAndSwap: true,
    systemOwnedRuntimeState: true,
    readExternalQualificationState: read,
    compareAndSwapExternalQualificationState({ expectedStateHash, state }) {
      assert.equal(
        read()?.autonomousExternalQualificationStateHash || null,
        expectedStateHash,
      );
      write(structuredClone(state));
      return state;
    },
  });
}

function hashed(kind, hashField, payload) {
  return Object.freeze({ ...payload, [hashField]: hashRecord(kind, payload) });
}

function principals() {
  const authorCapability = hashed('CodexResearchAuthorCapabilityReceipt',
    'codexResearchAuthorCapabilityReceiptHash', {
      version: 1, kind: 'CodexResearchAuthorCapabilityReceipt',
      status: 'codex_research_author_capability_ready', provider: 'openai', model: 'author',
      credentialRootIdentityHash: H('author-root'), credentialConfigIdentityHash: H('author-config'),
    });
  const reviewerCapability = hashed('CodexFormalReviewerCapabilityReceipt',
    'codexFormalReviewerCapabilityReceiptHash', {
      version: 1, kind: 'CodexFormalReviewerCapabilityReceipt',
      status: 'codex_formal_reviewer_capability_ready', provider: 'openai', model: 'reviewer',
      credentialRootIdentityHash: H('reviewer-root'),
      credentialConfigIdentityHash: H('reviewer-config'),
      authorCredentialRootIdentityHash: authorCapability.credentialRootIdentityHash,
      credentialIndependenceVerified: true,
      assuranceScope: 'filesystem_credential_root_and_principal_separation',
    });
  return {
    authorPrincipal: { principalId: 'author:qualification-test', capabilityReceipt: authorCapability },
    formalReviewerPrincipal: {
      principalId: 'reviewer:qualification-test', capabilityReceipt: reviewerCapability,
    },
  };
}

function receipt({
  privateKey,
  signer,
  campaignId,
  paperId,
  releaseHash,
  preparation,
  issuedAt,
  expiresAt,
}) {
  const unsigned = {
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    externalActionPerformed: true,
    campaignId,
    paperId,
    campaignReleaseBundleHash: releaseHash,
    proposalHash: preparation.proposal.machineProposedScientificClaimSetHash,
    policyAuthorizationHash:
      preparation.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
    seedBindingHash: preparation.seedBinding.autonomousResearchSeedBindingHash,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash: H(
      `prior-art:${preparation.proposal.machineProposedScientificClaimSetHash}`,
    ),
    runtimeImageReproducibilityReceiptHash: H(`runtime-reproducibility:${releaseHash}`),
    runtimeImageReproducibilityRequiredProfiles: ['python', 'pythonGpu', 'r'],
    runtimeImageReproducibilityDefinitionManifestHashes: {
      python: H('runtime-definition:python'),
      pythonGpu: H('runtime-definition:python-gpu'),
      r: H('runtime-definition:r'),
    },
    issuedAt,
    expiresAt,
    signer,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(fullResearchQualificationSigningPayloadHash(unsigned), 'utf8'),
    privateKey,
  ).toString('base64');
  const signed = { ...unsigned, signature };
  return Object.freeze({
    ...signed,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed),
  });
}

function resignQualificationReceipt(receiptValue, privateKey, mutate) {
  const {
    signature: _signature,
    fullResearchQualificationReceiptHash: _receiptHash,
    ...unsigned
  } = receiptValue;
  const changed = mutate(structuredClone(unsigned));
  const signature = crypto.sign(
    null,
    Buffer.from(fullResearchQualificationSigningPayloadHash(changed), 'utf8'),
    privateKey,
  ).toString('base64');
  const signed = { ...changed, signature };
  return Object.freeze({
    ...signed,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed),
  });
}

function writeFile(candidate, value, mode) {
  fs.writeFileSync(candidate, value, { mode });
  fs.chmodSync(candidate, mode);
}

function processFixture(t, {
  receiptValue,
  trustedSignerValues = null,
  maximumQualificationCostUsd = 1.5,
  qualificationCostAuthority = 'operator_declared_worst_case_usd',
}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-qualification-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const receiptPath = path.join(base, 'receipt.json');
  const verifierPrivateKeyPath = path.join(base, 'verifier-private.pem');
  const verifierPublicKeyPath = path.join(base, 'verifier-public.pem');
  const qualifierScript = path.join(base, 'qualifier.cjs');
  const verifierScript = path.join(base, 'verifier.cjs');
  const configPath = path.join(base, 'external-qualification.json');
  const qualifierCredentialRoot = path.join(base, 'qualifier-credentials');
  const verifierCredentialRoot = path.join(base, 'verifier-credentials');
  fs.mkdirSync(qualifierCredentialRoot, { mode: 0o700 });
  fs.mkdirSync(verifierCredentialRoot, { mode: 0o700 });
  writeFile(path.join(qualifierCredentialRoot, 'credential'),
    'qualifier-private-credential\n', 0o600);
  writeFile(path.join(verifierCredentialRoot, 'credential'),
    'verifier-private-credential\n', 0o600);
  const verifierKeys = crypto.generateKeyPairSync('ed25519');
  const verifierSigner = {
    keyId: 'independent-verifier-key:test',
    keyVersion: 'legacy-v1',
    subjectId: 'independent-verifier:test',
    organization: 'Independent Verification Test',
    role: 'external_qualification_independent_verifier',
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  };
  writeFile(receiptPath, `${JSON.stringify(receiptValue)}\n`, 0o600);
  const signerValues = trustedSignerValues || [{
    ...receiptValue.signer,
    publicKeyPem: receiptValue.publicKeyPem,
  }];
  const trustedSignerKeys = signerValues.map((value, index) => {
    const publicKeyPath = path.join(base, `qualification-public-${index}.pem`);
    writeFile(publicKeyPath, value.publicKeyPem, 0o600);
    const { publicKeyPem: _publicKeyPem, ...signerValue } = value;
    return Object.freeze({ ...signerValue, publicKeyPath });
  });
  writeFile(verifierPrivateKeyPath,
    verifierKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  writeFile(verifierPublicKeyPath,
    verifierKeys.publicKey.export({ type: 'spki', format: 'pem' }), 0o600);
  writeFile(qualifierScript, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  delete value.publicKeyPem;
  process.stdout.write(JSON.stringify({ version: 1, kind: 'ExternalResearchQualificationResponse', serviceId: request.serviceId, requestHash: request.requestHash, receipt: value }));
});
`, 0o700);
  writeFile(verifierScript, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function hashRecord(kind, value) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(stable({ kind, value }))).digest('hex');
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const receipt = request.receipt;
  const payload = {
    version: 1,
    kind: 'IndependentExternalResearchQualificationVerificationResponse',
    verifierId: request.verifierId,
    requestHash: request.requestHash,
    signer: ${JSON.stringify(verifierSigner)},
    inspection: {
      version: 1,
      kind: 'FullResearchQualificationInspection',
      status: 'full_research_qualification_verified',
      ready: true,
      receiptAccepted: true,
      campaignId: receipt.campaignId,
      paperId: receipt.paperId,
      campaignReleaseBundleHash: receipt.campaignReleaseBundleHash,
      qualificationReceiptHash: receipt.fullResearchQualificationReceiptHash,
      runtimeImageReproducibilityReceiptHash: receipt.runtimeImageReproducibilityReceiptHash,
      runtimeImageReproducibilityRequiredProfiles: receipt.runtimeImageReproducibilityRequiredProfiles,
      runtimeImageReproducibilityDefinitionManifestHashes: receipt.runtimeImageReproducibilityDefinitionManifestHashes,
      proposalHash: receipt.proposalHash,
      policyAuthorizationHash: receipt.policyAuthorizationHash,
      seedBindingHash: receipt.seedBindingHash,
      independentHypothesisPriorArtReviewVerified: true,
      independentHypothesisPriorArtReceiptHash: receipt.independentHypothesisPriorArtReceiptHash,
      blockers: [],
    },
  };
  const responseHash = hashRecord('IndependentExternalResearchQualificationVerificationResponse', payload);
  const signingPayloadHash = hashRecord('IndependentExternalResearchQualificationVerificationResponseSigningPayload', payload);
  const signature = crypto.sign(null, Buffer.from(signingPayloadHash, 'utf8'), fs.readFileSync(process.argv[2], 'utf8')).toString('base64');
  process.stdout.write(JSON.stringify({ ...payload, responseHash, signature }));
});
`, 0o700);
  const configuration = {
    version: 3,
    kind: 'ExternalResearchQualificationProcessConfiguration',
    status: 'active',
    maximumQualificationCostUsd,
    qualificationCostAuthority,
    qualifier: {
      serviceId: 'external-qualifier:test',
      principalId: 'external-qualifier-principal:test',
      protocol: 'external-qualification-json-stdio-v1',
      executable: qualifierScript,
      credentialRoot: qualifierCredentialRoot,
      args: [receiptPath],
      environmentAllowlist: [],
      timeoutMs: 10_000,
    },
    verifier: {
      serviceId: 'independent-verifier:test',
      principalId: 'independent-verifier-principal:test',
      protocol: 'external-qualification-json-stdio-v1',
      executable: verifierScript,
      credentialRoot: verifierCredentialRoot,
      args: [verifierPrivateKeyPath],
      environmentAllowlist: [],
      timeoutMs: 10_000,
    },
    trustedSignerTrustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: trustedSignerKeys,
    },
    verifierAttestor: {
      ...verifierSigner,
      publicKeyPath: verifierPublicKeyPath,
    },
  };
  writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, 0o600);
  return { base, configPath, configuration, receiptPath, verifierPrivateKeyPath };
}

function releaseAuthority(campaignId, paperId, releaseHash, preparation) {
  const campaignPlanHash = H(`campaign-plan:${campaignId}`);
  const autonomousResearchReleaseBinding = createAutonomousResearchReleaseBinding({
    campaignId,
    paperId,
    campaignPlanHash,
    preparation,
  });
  return Object.freeze({
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId,
    paperId,
    campaignReleaseBundleHash: releaseHash,
    releaseBundle: Object.freeze({
      campaignPlanHash,
      campaignReleaseBundleHash: releaseHash,
      autonomousResearchReleaseBindingHash:
        autonomousResearchReleaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding,
      researchReport: Object.freeze({
        promotionEligibility: Object.freeze({ status: 'research_promotion_ready' }),
      }),
    }),
  });
}

test('process qualifier and distinct verifier enforce signature, time, and current release binding', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:test',
    organization: 'External Qualification Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const campaignId = 'autonomous-research:process-qualified';
  const paperId = 'process-qualified';
  const releaseHash = H('current-release');
  const preparation = await prepareAutonomousResearchLoop({
    paperId,
    ...principals(),
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T11:00:00.000Z',
  });
  const validReceipt = receipt({
    privateKey,
    signer,
    campaignId,
    paperId,
    releaseHash,
    preparation,
    issuedAt: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-07-15T13:00:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: {
      ...validReceipt,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    },
  });
  let now = new Date('2026-07-15T12:30:00.000Z');
  const adapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
  });
  assert.equal(adapter.inspection.independentVerifierConfigured, true);
  assert.equal(adapter.inspection.privateSigningKeyLoaded, false);
  assert.equal(adapter.inspection.maximumQualificationCostUsd, 1.5);
  assert.equal(
    adapter.inspection.qualificationCostAuthority,
    'operator_declared_worst_case_usd',
  );
  assert.equal(adapter.client.maximumQualificationCostUsd, 1.5);
  assert.equal(adapter.verifier.maximumQualificationCostUsd, 1.5);
  const authority = releaseAuthority(campaignId, paperId, releaseHash, preparation);
  const issued = await adapter.client.requestQualification({ campaignId, paperId, releaseHash });
  const verified = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(verified.ready, false);
  assert.ok(verified.blockers.includes('external_qualification_full_verification_context_required'));

  const verifierPrivateKey = fs.readFileSync(fixture.verifierPrivateKeyPath, 'utf8');
  const attackerVerifierKey = crypto.generateKeyPairSync('ed25519').privateKey
    .export({ type: 'pkcs8', format: 'pem' });
  writeFile(fixture.verifierPrivateKeyPath, attackerVerifierKey, 0o600);
  const verifierAttestationBlocked = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(verifierAttestationBlocked.ready, false);
  assert.ok(verifierAttestationBlocked.blockers.some((blocker) => blocker.includes(
    'external_qualification_process_identity_changed',
  )));
  writeFile(fixture.verifierPrivateKeyPath, verifierPrivateKey, 0o600);

  const attackerSigned = { ...issued, signature: Buffer.alloc(64, 7).toString('base64') };
  const tamperedSignature = {
    ...attackerSigned,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', attackerSigned),
  };
  const signatureBlocked = await adapter.verifier.verify({
    receipt: tamperedSignature,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(signatureBlocked.ready, false);
  assert.ok(signatureBlocked.blockers.includes('external_qualification_signature_invalid'));

  const priorArtBlocked = await adapter.verifier.verify({
    receipt: resignQualificationReceipt(issued, privateKey, (candidate) => {
      candidate.independentHypothesisPriorArtReviewVerified = false;
      return candidate;
    }),
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(priorArtBlocked.ready, false);
  assert.ok(priorArtBlocked.blockers.includes(
    'external_qualification_independent_hypothesis_prior_art_qualification_invalid',
  ));
  assert.ok(priorArtBlocked.failureCodes.includes(
    'external_qualification.prior_art_qualification_invalid',
  ));

  const releaseBlocked = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority:
      releaseAuthority(campaignId, paperId, H('replacement-release'), preparation),
    preparation,
  });
  assert.equal(releaseBlocked.ready, false);
  assert.ok(releaseBlocked.blockers.includes('external_qualification_current_release_pointer_mismatch'));

  const priorPreparation = await prepareAutonomousResearchLoop({
    paperId,
    objective: 'A superseded machine hypothesis for the same paper identifier',
    ...principals(),
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-14T11:00:00.000Z',
  });
  const priorReceipt = receipt({
    privateKey,
    signer,
    campaignId,
    paperId,
    releaseHash,
    preparation: priorPreparation,
    issuedAt: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-07-15T13:00:00.000Z',
  });
  const substitutionBlocked = await adapter.verifier.verify({
    receipt: priorReceipt,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(substitutionBlocked.ready, false);
  assert.ok(substitutionBlocked.blockers.includes(
    'external_qualification_autonomous_preparation_binding_mismatch',
  ));

  now = new Date('2026-07-15T13:00:00.000Z');
  const expired = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(expired.ready, false);
  assert.ok(expired.blockers.includes('external_qualification_receipt_outside_time_window'));
});

test('campaign never caches an envelope-only receipt and rejects stale cached receipts', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:cache-test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:cache-test',
    organization: 'Cache Qualification Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const campaignId = 'autonomous-research:cache-revalidation';
  const paperId = 'cache-revalidation';
  const releaseHash = H('cache-release');
  const preparation = await prepareAutonomousResearchLoop({
    paperId,
    ...principals(),
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T13:00:00.000Z',
  });
  const validReceipt = receipt({
    privateKey,
    signer,
    campaignId,
    paperId,
    releaseHash,
    preparation,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: {
      ...validReceipt,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    },
  });
  let now = new Date('2026-07-15T14:30:00.000Z');
  const adapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
  });
  const campaign = {
    campaignId,
    paperId,
    status: 'completed',
    spec: { autonomousResearchPreparation: preparation },
  };
  const campaignStore = {
    createCampaign() { throw new Error('unexpected create'); },
    getCampaign() { return campaign; },
    listNodes() { return []; },
    resumeCampaign() { throw new Error('unexpected resume'); },
  };
  let cachedState = null;
  const qualificationStateStore = memoryQualificationStateStore({
    read() { return cachedState; },
    write(value) { cachedState = value; },
  });
  const common = {
    campaignId,
    campaignStore,
    campaignReleaseAuthorityReader:
      () => releaseAuthority(campaignId, paperId, releaseHash, preparation),
    externalQualificationClient: adapter.client,
    externalQualificationVerifier: adapter.verifier,
    qualificationStateStore,
  };
  const envelopeOnly = await executeAutonomousResearchCampaign({ ...common, action: 'resume' });
  assert.notEqual(envelopeOnly.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(envelopeOnly.externalQualification.status, 'qualification_external_service_blocked');
  assert.equal(cachedState.version, 4);
  assert.equal(cachedState.receipt, null);
  assert.equal(cachedState.recovery.status, 'qualification_terminal_blocked');
  assert.equal(cachedState.verifiedInspection, null);
  cachedState = {
    version: 2,
    kind: 'AutonomousExternalQualificationState',
    campaignId,
    paperId,
    campaignReleaseBundleHash: releaseHash,
    receipt: validReceipt,
  };

  const missingVerifier = await executeAutonomousResearchCampaign({
    ...common,
    action: 'status',
    externalQualificationClient: null,
    externalQualificationVerifier: null,
  });
  assert.notEqual(missingVerifier.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(missingVerifier.externalQualification.status,
    'qualification_external_state_invalid');

  now = new Date('2026-07-15T15:00:00.000Z');
  const staleStatus = await executeAutonomousResearchCampaign({ ...common, action: 'status' });
  assert.notEqual(staleStatus.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(staleStatus.externalQualification.status,
    'qualification_external_state_invalid');
  assert.equal(staleStatus.qualificationEligibility.fullAutomaticResearchWritingReady, false);

  now = new Date('2026-07-15T14:30:00.000Z');
  const forgedPayload = {
    ...validReceipt,
    signature: Buffer.alloc(64, 3).toString('base64'),
  };
  delete forgedPayload.fullResearchQualificationReceiptHash;
  const forgedReceipt = {
    ...forgedPayload,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', forgedPayload),
  };
  writeFile(fixture.receiptPath, `${JSON.stringify(forgedReceipt)}\n`, 0o600);
  const forgedAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
  });
  let forgedCache = null;
  const forgedAttempt = await executeAutonomousResearchCampaign({
    ...common,
    action: 'resume',
    externalQualificationClient: forgedAdapter.client,
    externalQualificationVerifier: forgedAdapter.verifier,
    qualificationStateStore: memoryQualificationStateStore({
      read() { return forgedCache; },
      write(value) { forgedCache = value; },
    }),
  });
  assert.notEqual(forgedAttempt.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(forgedAttempt.externalQualification.status, 'qualification_external_service_blocked');
  assert.equal(forgedCache.version, 4);
  assert.equal(forgedCache.receipt, null);
  assert.equal(forgedCache.recovery.status, 'qualification_terminal_blocked');
  assert.equal(forgedCache.verifiedInspection, null);
});

test('configuration v3 binds qualifier and verifier total cost authority into identity', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:cost-authority',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:cost-authority',
    organization: 'External Qualification Cost Authority',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const preparation = await prepareAutonomousResearchLoop({
    paperId: 'qualification-cost-authority',
    ...principals(),
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T13:00:00.000Z',
  });
  const value = receipt({
    privateKey,
    signer,
    campaignId: 'autonomous-research:qualification-cost-authority',
    paperId: 'qualification-cost-authority',
    releaseHash: H('qualification-cost-authority-release'),
    preparation,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: {
      ...value,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    },
  });
  const original = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.equal(original.maximumQualificationCostUsd, 1.5);
  assert.equal(original.qualificationCostAuthority, 'operator_declared_worst_case_usd');

  const writeConfiguration = (configuration) => writeFile(
    fixture.configPath,
    `${JSON.stringify(configuration, null, 2)}\n`,
    0o600,
  );
  writeConfiguration({ ...fixture.configuration, maximumQualificationCostUsd: 2.25 });
  const repriced = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.notEqual(repriced.configurationIdentityHash, original.configurationIdentityHash);

  for (const invalid of [
    { ...fixture.configuration, version: 2 },
    { ...fixture.configuration, maximumQualificationCostUsd: 0 },
    { ...fixture.configuration, maximumQualificationCostUsd: 1000.01 },
    {
      ...fixture.configuration,
      maximumQualificationCostUsd: 1,
      qualificationCostAuthority: 'externally_operated_zero_cost',
    },
  ]) {
    writeConfiguration(invalid);
    assert.throws(() => readExternalResearchQualificationProcessConfiguration({
      configPath: fixture.configPath,
      environment: process.env,
    }), /external_qualification_configuration_invalid/);
  }

  writeConfiguration({
    ...fixture.configuration,
    maximumQualificationCostUsd: 0,
    qualificationCostAuthority: 'externally_operated_zero_cost',
  });
  const zeroCost = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.equal(zeroCost.maximumQualificationCostUsd, 0);
  assert.equal(zeroCost.qualificationCostAuthority, 'externally_operated_zero_cost');
});

test('configuration rejects a qualifier posing as its own independent verifier', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:separation-test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:separation-test',
    organization: 'Release Qualification Separation Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const preparation = await prepareAutonomousResearchLoop({
    paperId: 'separation',
    ...principals(),
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T13:00:00.000Z',
  });
  const value = receipt({
    privateKey,
    signer,
    campaignId: 'autonomous-research:separation',
    paperId: 'separation',
    releaseHash: H('separation-release'),
    preparation,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: { ...value, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) },
  });
  const configuration = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  configuration.verifier = {
    ...configuration.verifier,
    executable: configuration.qualifier.executable,
    args: [...configuration.qualifier.args, '--pretend-independent-verifier'],
  };
  writeFile(fixture.configPath, `${JSON.stringify(configuration, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_required/);

  const sharedCredentialConfigPath = path.join(fixture.base, 'shared-credential-config.json');
  writeFile(sharedCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    verifier: {
      ...fixture.configuration.verifier,
      credentialRoot: fixture.configuration.qualifier.credentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: sharedCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_required/);

  const emptyCredentialRoot = path.join(fixture.base, 'empty-credential-root');
  fs.mkdirSync(emptyCredentialRoot, { mode: 0o700 });
  const emptyCredentialConfigPath = path.join(
    fixture.base,
    'empty-credential-config.json',
  );
  writeFile(emptyCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    qualifier: {
      ...fixture.configuration.qualifier,
      credentialRoot: emptyCredentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: emptyCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_credential_root_contents_invalid/);

  const zeroByteCredentialRoot = path.join(fixture.base, 'zero-byte-credential-root');
  fs.mkdirSync(zeroByteCredentialRoot, { mode: 0o700 });
  writeFile(path.join(zeroByteCredentialRoot, 'empty-token'), '', 0o600);
  const zeroByteCredentialConfigPath = path.join(
    fixture.base,
    'zero-byte-credential-config.json',
  );
  writeFile(zeroByteCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    verifier: {
      ...fixture.configuration.verifier,
      credentialRoot: zeroByteCredentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: zeroByteCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_credential_root_contents_invalid/);

  const copiedQualifierCredentialRoot = path.join(
    fixture.base,
    'copied-qualifier-credentials',
  );
  const copiedVerifierCredentialRoot = path.join(
    fixture.base,
    'copied-verifier-credentials',
  );
  fs.mkdirSync(copiedQualifierCredentialRoot, { mode: 0o700 });
  fs.mkdirSync(copiedVerifierCredentialRoot, { mode: 0o700 });
  writeFile(path.join(copiedQualifierCredentialRoot, 'qualifier-token'),
    'same-private-credential\n', 0o600);
  writeFile(path.join(copiedVerifierCredentialRoot, 'renamed-verifier-token'),
    'same-private-credential\n', 0o600);
  writeFile(path.join(copiedVerifierCredentialRoot, 'unrelated-material'),
    'different-private-credential\n', 0o600);
  const copiedCredentialConfigPath = path.join(
    fixture.base,
    'copied-credential-config.json',
  );
  writeFile(copiedCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    qualifier: {
      ...fixture.configuration.qualifier,
      credentialRoot: copiedQualifierCredentialRoot,
    },
    verifier: {
      ...fixture.configuration.verifier,
      credentialRoot: copiedVerifierCredentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: copiedCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_required/);

  const missingVerifierOrganizationPath = path.join(
    fixture.base,
    'missing-verifier-organization-config.json',
  );
  writeFile(missingVerifierOrganizationPath, `${JSON.stringify({
    ...fixture.configuration,
    verifierAttestor: {
      ...fixture.configuration.verifierAttestor,
      organization: null,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: missingVerifierOrganizationPath,
    cwd: fixture.base,
  }), /external_qualification_verifier_attestor_invalid/);

  const missingReleaseOrganizationPath = path.join(
    fixture.base,
    'missing-release-organization-config.json',
  );
  writeFile(missingReleaseOrganizationPath, `${JSON.stringify({
    ...fixture.configuration,
    trustedSignerTrustSet: {
      ...fixture.configuration.trustedSignerTrustSet,
      keys: fixture.configuration.trustedSignerTrustSet.keys.map((key, index) => (
        index === 0 ? { ...key, organization: null } : key
      )),
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: missingReleaseOrganizationPath,
    cwd: fixture.base,
  }), /external_qualification_trusted_signer_invalid/);

  const sharedOrganizationConfigPath = path.join(
    fixture.base,
    'shared-organization-config.json',
  );
  writeFile(sharedOrganizationConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    verifierAttestor: {
      ...fixture.configuration.verifierAttestor,
      organization: `${signer.organization.toUpperCase()}  `,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: sharedOrganizationConfigPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_organization_required/);

  const privateKeyPath = path.join(fixture.base, 'forbidden-private-key.pem');
  const privateConfigPath = path.join(fixture.base, 'private-key-config.json');
  writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  writeFile(privateConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    trustedSignerTrustSet: {
      ...fixture.configuration.trustedSignerTrustSet,
      keys: fixture.configuration.trustedSignerTrustSet.keys.map((key, index) => (
        index === 0 ? { ...key, publicKeyPath: privateKeyPath } : key
      )),
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: privateConfigPath,
    cwd: fixture.base,
  }), /external_qualification_trusted_signer_public_key_invalid/);
});

test('configuration rejects one Ed25519 signer key under different PEM encodings', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:spki-separation-test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:spki-separation-test',
    organization: 'SPKI Separation Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const preparation = await prepareAutonomousResearchLoop({
    paperId: 'spki-separation',
    ...principals(),
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T13:00:00.000Z',
  });
  const value = receipt({
    privateKey,
    signer,
    campaignId: 'autonomous-research:spki-separation',
    paperId: 'spki-separation',
    releaseHash: H('spki-separation-release'),
    preparation,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const canonicalPem = publicKey.export({ type: 'spki', format: 'pem' });
  const fixture = processFixture(t, {
    receiptValue: { ...value, publicKeyPem: canonicalPem },
  });
  const alternatePublicKeyPath = path.join(fixture.base, 'same-spki-different-pem.pem');
  const alternatePem = canonicalPem.replaceAll('\n', '\r\n');
  assert.notEqual(alternatePem, canonicalPem);
  writeFile(alternatePublicKeyPath, alternatePem, 0o600);
  assert.deepEqual(
    crypto.createPublicKey(alternatePem).export({ type: 'spki', format: 'der' }),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const configuration = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  configuration.verifierAttestor.publicKeyPath = alternatePublicKeyPath;
  writeFile(fixture.configPath, `${JSON.stringify(configuration, null, 2)}\n`, 0o600);

  const inspection = inspectExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'external_qualification_independent_verifier_attestor_required',
  ));
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_attestor_required/);
});

function productionReleaseInspection({ trustedKeys, activeKey }) {
  const payload = {
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfigurationInspection',
    status: 'research_execution_release_attestor_ready',
    ready: true,
    productionStatus: 'research_execution_release_attestor_production_ready',
    productionReady: true,
    inspectedAt: '2026-07-15T12:30:00.000Z',
    keyId: activeKey.keyId,
    keyVersion: activeKey.keyVersion,
    subjectId: activeKey.subjectId,
    organization: activeKey.organization,
    role: activeKey.role,
    algorithm: activeKey.algorithm,
    publicKeySpkiHash: activeKey.publicKeySpkiHash,
    effectiveFrom: activeKey.effectiveFrom,
    expiresAt: activeKey.expiresAt,
    trustSetVersion: 1,
    trustSetHash: hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
      version: 1,
      keys: trustedKeys,
    }),
    trustedKeys,
    backendKind: 'external-kms-command',
    backendProductionEligible: true,
    hardwareProtected: true,
    privateKeyExportable: false,
    externalSignerProcess: true,
    independentBackendProbeVerified: true,
    activeSignerChallengeVerified: true,
    activeSignerChallengeSigningPayloadHash: H('release-active-signer-challenge-payload'),
    activeSignerChallengeVerificationHash: H('release-active-signer-challenge-verification'),
    blockers: [],
    productionBlockers: [],
  };
  return Object.freeze({
    ...payload,
    researchExecutionReleaseAttestorConfigurationInspectionHash: hashRecord(
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      payload,
    ),
  });
}

test('preprovisioned trust survives release-only cutover and enforces active, retiring, future, and revoked authority', async (t) => {
  const oldKeys = crypto.generateKeyPairSync('ed25519');
  const nextKeys = crypto.generateKeyPairSync('ed25519');
  const oldSigner = Object.freeze({
    keyId: 'qualification-key:rotation-old',
    keyVersion: 'v1',
    subjectId: 'external-attestor:rotation',
    organization: 'External Qualification Rotation',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    revokedAt: null,
  });
  const nextSigner = Object.freeze({
    ...oldSigner,
    keyId: 'qualification-key:rotation-next',
    keyVersion: 'v2',
    status: 'retiring',
    effectiveFrom: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
  });
  const preparation = await prepareAutonomousResearchLoop({
    paperId: 'rotation-authority',
    ...principals(),
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  const activeReceipt = receipt({
    privateKey: nextKeys.privateKey,
    signer: nextSigner,
    campaignId: 'autonomous-research:rotation-authority',
    paperId: 'rotation-authority',
    releaseHash: H('rotation-release'),
    preparation,
    issuedAt: '2026-07-15T12:30:00.000Z',
    expiresAt: '2026-07-15T13:30:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: {
      ...activeReceipt,
      publicKeyPem: nextKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    },
    trustedSignerValues: [{
      ...oldSigner,
      publicKeyPem: oldKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    }, {
      ...nextSigner,
      publicKeyPem: nextKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    }],
  });
  const configuration = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  const cutoverKeys = Object.freeze(configuration.trustedSigners.map((key) => Object.freeze({
    ...key,
    status: key.keyId === nextSigner.keyId ? 'active' : 'retiring',
  })));
  const currentActive = cutoverKeys.find((key) => key.status === 'active');
  const cutover = productionReleaseInspection({
    trustedKeys: cutoverKeys,
    activeKey: currentActive,
  });
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: nextSigner,
    signedAt: '2026-07-15T12:30:00.000Z',
    freshlyIssued: true,
  }), true);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: oldSigner,
    signedAt: '2026-07-15T12:30:00.000Z',
    freshlyIssued: true,
  }), false);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: oldSigner,
    signedAt: '2026-07-15T11:59:59.000Z',
  }), true);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: oldSigner,
    signedAt: '2026-07-15T12:00:00.000Z',
  }), false);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: nextSigner,
    signedAt: '2026-07-15T11:59:59.000Z',
  }), false);
  const revokedKeys = Object.freeze(cutoverKeys.map((key) => Object.freeze({
    ...key,
    ...(key.keyId === nextSigner.keyId
      ? { revokedAt: '2026-07-15T12:15:00.000Z' } : {}),
  })));
  const revoked = productionReleaseInspection({
    trustedKeys: revokedKeys,
    activeKey: revokedKeys.find((key) => key.keyId === nextSigner.keyId),
  });
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: revoked,
    configuration,
    signer: nextSigner,
    signedAt: '2026-07-15T12:10:00.000Z',
    freshlyIssued: true,
  }), false);
});
