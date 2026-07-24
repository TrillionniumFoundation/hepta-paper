import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import {
  createExternalResearchQualificationProcessAdapter,
} from '../../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import {
  invokeExternalResearchQualificationProcess,
  readExternalResearchQualificationProcessConfiguration,
} from '../../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {
  INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS,
  verifyIndependentExternalResearchQualificationVerificationEvidence,
} from '../../../paper-adapters/automation/external-research-qualification-verifier-attestation.mjs';
import {
  buildIndependentExternalResearchQualificationVerificationEvidence,
  buildIndependentExternalResearchQualificationVerificationRequest,
  independentExternalResearchQualificationEvidenceHash,
  independentExternalResearchQualificationRequestHash,
  independentExternalResearchQualificationResponseSigningPayloadHash,
} from '../../../paper-domain/automation/external-research-qualification-verification-evidence-contract.mjs';
import {
  runBoundedChildProcess,
} from '../../../paper-adapters/automation/bounded-child-process.mjs';

const H = (label) => hashRecord(
  'AutonomousExternalQualificationSignedEvidenceTestHash',
  { label },
);
const BINDING_FAILURE =
  'external_qualification.independent_verification_binding_invalid';
const ATTESTATION_FAILURE =
  'external_qualification.independent_verifier_attestation_invalid';

function resignResponse(response, privateKey, mutate) {
  const { signature: _signature, responseHash: _responseHash, ...payload } = response;
  const changed = mutate(structuredClone(payload));
  const responseHash = hashRecord(
    'IndependentExternalResearchQualificationVerificationResponse',
    changed,
  );
  const signature = crypto.sign(
    null,
    Buffer.from(
      independentExternalResearchQualificationResponseSigningPayloadHash(changed),
      'utf8',
    ),
    privateKey,
  ).toString('base64');
  return Object.freeze({ ...changed, responseHash, signature });
}

function rehashResponse(response, mutate) {
  const { signature, responseHash: _responseHash, ...payload } = response;
  const changed = mutate(structuredClone(payload));
  return Object.freeze({
    ...changed,
    responseHash: hashRecord(
      'IndependentExternalResearchQualificationVerificationResponse',
      changed,
    ),
    signature,
  });
}

function rehashRequest(request, mutate) {
  const { requestHash: _requestHash, ...payload } = request;
  const changed = mutate(structuredClone(payload));
  return Object.freeze({
    ...changed,
    requestHash:
      independentExternalResearchQualificationRequestHash(changed),
  });
}

function rehashEvidence(evidence, mutate) {
  const {
    independentExternalResearchQualificationVerificationEvidenceHash: _hash,
    ...payload
  } = evidence;
  const changed = mutate(structuredClone(payload));
  return Object.freeze({
    ...changed,
    independentExternalResearchQualificationVerificationEvidenceHash:
      independentExternalResearchQualificationEvidenceHash(changed),
  });
}

async function liveEvidence({
  fixture,
  configuration,
  receipt,
  authority,
  preparation,
  verifiedAt,
}) {
  const request =
    buildIndependentExternalResearchQualificationVerificationRequest({
      receipt,
      campaignReleaseAuthority: authority,
      preparation,
      verifierId: configuration.verifier.serviceId,
      verifiedAt,
    });
  const response = await invokeExternalResearchQualificationProcess(
    configuration.verifier,
    request,
    {
      cwd: fixture.base,
      environment: process.env,
      runProcess: runBoundedChildProcess,
    },
  );
  return buildIndependentExternalResearchQualificationVerificationEvidence({
    request,
    response,
    configurationIdentityHash: configuration.configurationIdentityHash,
    trustIdentityHash: configuration.trustIdentityHash,
    verifierServiceIdentityHash: configuration.verifierServiceIdentityHash,
  });
}

export async function exerciseExternalQualificationSignedEvidence({
  t,
  fixture,
  fullConfiguration,
  receiptValue,
  issued,
  authority,
  preparation,
  now,
  adapter,
  processFixture,
  donorReceipt,
  donorAuthority,
  donorPreparation,
}) {
  const evidence = await liveEvidence({
    fixture,
    configuration: fullConfiguration,
    receipt: issued,
    authority,
    preparation,
    verifiedAt: now.toISOString(),
  });
  const evidenceInput = {
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
    configuration: fullConfiguration,
  };
  const verifyEvidence = (candidate, verificationTime = now) => (
    verifyIndependentExternalResearchQualificationVerificationEvidence(
      candidate,
      { ...evidenceInput, verificationTime },
    )
  );
  const verifyLocally = (candidate, verifier = adapter.verifier) => (
    verifier.verifyLocally({
      receipt: issued,
      campaignReleaseAuthority: authority,
      preparation,
      independentVerificationEvidence: candidate,
    })
  );
  const valid = verifyEvidence(evidence);
  assert.equal(valid.valid, true);
  assert.equal(valid.signatureVerified, true);
  assert.equal(valid.timeWindowVerified, true);
  const local = await verifyLocally(evidence);
  assert.equal(local.ready, false);
  assert.deepEqual(local.failureCodes, [
    'external_qualification.full_verification_context_configuration_missing',
  ]);
  assert.ok(local.blockers.includes(
    'external_qualification_full_verification_context_required',
  ));

  const verifierPrivateKey = fs.readFileSync(
    fixture.verifierPrivateKeyPath,
    'utf8',
  );
  const responseEvidence = (mutate, sign = false) => (
    rehashEvidence(evidence, (candidate) => {
      candidate.response = sign
        ? resignResponse(
          candidate.response,
          verifierPrivateKey,
          (response) => mutate(response, candidate),
        )
        : rehashResponse(
          candidate.response,
          (response) => mutate(response, candidate),
        );
      return candidate;
    })
  );
  const signedAtEvidence = (offsetMs) => responseEvidence(
    (response, candidate) => {
      response.signedAt = new Date(
        Date.parse(candidate.request.verifiedAt) + offsetMs,
      ).toISOString();
      return response;
    },
    true,
  );
  const tamperedInspection = responseEvidence((response) => {
    response.inspection.structuredPriorArtEvidenceVerified = false;
    return response;
  });
  const tamperedPolicy = responseEvidence((response) => {
    response.verificationPolicyHash = H('tampered-policy');
    return response;
  });
  const tamperedRequest = rehashEvidence(evidence, (candidate) => {
    candidate.request = rehashRequest(candidate.request, (request) => {
      request.expectedBindings.proposalHash = H('tampered-proposal');
      return request;
    });
    return candidate;
  });
  const tamperedSignature = rehashEvidence(evidence, (candidate) => {
    candidate.response.signature = Buffer.alloc(64, 5).toString('base64');
    return candidate;
  });
  const legacyV1 = responseEvidence((response) => {
    response.version = 1;
    return response;
  }, true);
  for (const [label, candidate, failureCode] of [
    ['missing', null, BINDING_FAILURE],
    ['bare', evidence.response.inspection, BINDING_FAILURE],
    ['inspection', tamperedInspection, BINDING_FAILURE],
    ['policy', tamperedPolicy, BINDING_FAILURE],
    ['request', tamperedRequest, BINDING_FAILURE],
    ['signature', tamperedSignature, ATTESTATION_FAILURE],
    ['v1', legacyV1, BINDING_FAILURE],
  ]) {
    assert.equal(verifyEvidence(candidate).valid, false, label);
    const blocked = await verifyLocally(candidate);
    assert.equal(blocked.ready, false, label);
    assert.deepEqual(blocked.failureCodes, [failureCode], label);
  }

  for (const offsetMs of [
    -INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS,
    INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS,
  ]) {
    assert.equal(verifyEvidence(signedAtEvidence(offsetMs)).valid, true);
  }
  for (const offsetMs of [
    -INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS - 1,
    INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS + 1,
  ]) {
    const candidate = signedAtEvidence(offsetMs);
    const blocked = verifyEvidence(candidate);
    assert.equal(blocked.valid, false);
    assert.equal(blocked.timeWindowVerified, false);
    assert.deepEqual(
      (await verifyLocally(candidate)).failureCodes,
      [ATTESTATION_FAILURE],
    );
  }

  const expiresAt = new Date(now.getTime() + (60 * 1000)).toISOString();
  const windowFixture = processFixture(t, {
    receiptValue,
    verifierAttestorEffectiveFrom: now.toISOString(),
    verifierAttestorExpiresAt: expiresAt,
  });
  const windowConfiguration =
    readExternalResearchQualificationProcessConfiguration({
      configPath: windowFixture.configPath,
      environment: process.env,
    });
  const windowEvidence = await liveEvidence({
    fixture: windowFixture,
    configuration: windowConfiguration,
    receipt: issued,
    authority,
    preparation,
    verifiedAt: now.toISOString(),
  });
  const verifyWindow = (verificationTime) => (
    verifyIndependentExternalResearchQualificationVerificationEvidence(
      windowEvidence,
      {
        ...evidenceInput,
        configuration: windowConfiguration,
        verificationTime,
      },
    )
  );
  assert.equal(verifyWindow(now).valid, true);
  assert.equal(verifyWindow(new Date(Date.parse(expiresAt) - 1)).valid, true);
  const expired = verifyWindow(new Date(expiresAt));
  assert.equal(expired.valid, false);
  assert.equal(expired.timeWindowVerified, false);
  const expiredAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: windowFixture.configPath,
    cwd: windowFixture.base,
    clock: { now: () => new Date(expiresAt) },
  });
  assert.deepEqual(
    (await verifyLocally(
      windowEvidence,
      expiredAdapter.verifier,
    )).failureCodes,
    [ATTESTATION_FAILURE],
  );

  const retiringFixture = processFixture(t, {
    receiptValue,
    verifierAttestorStatus: 'retiring',
  });
  assert.throws(
    () => createExternalResearchQualificationProcessAdapter({
      configPath: retiringFixture.configPath,
      cwd: retiringFixture.base,
      clock: { now: () => now },
    }),
    /external_qualification_verifier_attestor_invalid/,
  );
  const retiringEvidence = responseEvidence((response) => {
    response.signer.status = 'retiring';
    return response;
  }, true);
  const retiring = verifyEvidence(retiringEvidence);
  assert.equal(retiring.valid, false);
  assert.equal(retiring.structureVerified, true);
  assert.deepEqual(
    (await verifyLocally(retiringEvidence)).failureCodes,
    [ATTESTATION_FAILURE],
  );

  const donorEvidence = await liveEvidence({
    fixture,
    configuration: fullConfiguration,
    receipt: donorReceipt,
    authority: donorAuthority,
    preparation: donorPreparation,
    verifiedAt: now.toISOString(),
  });
  const donorSplice = verifyEvidence(donorEvidence);
  assert.equal(donorSplice.valid, false);
  assert.ok(donorSplice.blockers.some((blocker) => (
    blocker.includes('current_binding_invalid')
      || blocker.includes('request_policy_invalid')
  )));
  const donorBlocked = await verifyLocally(donorEvidence);
  assert.equal(donorBlocked.ready, false);
  assert.ok(donorBlocked.blockers.includes(
    'external_qualification_independent_verification_binding_invalid',
  ));
  assert.deepEqual(donorBlocked.failureCodes, [BINDING_FAILURE]);
}
