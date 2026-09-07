import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = path.join(
  root,
  'docs/provider-sandbox/schemas/provider-external-acceptance-receipt-v1.schema.json',
);
const template = path.join(
  root,
  'docs/provider-sandbox/templates/provider-external-acceptance-receipt-v1.template.json',
);
const validator = path.join(root, 'docs/rust/tools/strict_json_schema.py');
const digest = `sha256:${'a'.repeat(64)}`;

function receipt() {
  const decision = (role, suffix) => ({
    role,
    principalId: `${role}-${suffix}`,
    decision: 'technical_external_acceptance_approved_non_authorizing',
    decidedAt: '2026-09-07T00:10:00Z',
    signedPayloadSha256: digest,
    signatureArtifactSha256: digest,
    algorithm: 'ed25519',
  });
  return {
    schemaVersion: 1,
    kind: 'ProviderExternalAcceptanceReceiptV1',
    status: 'technical_external_companion_accepted_non_authorizing',
    exactSubject: {
      repositoryId: 1349108143,
      repository: 'TrillionniumFoundation/hepta-paper',
      pullRequest: 103,
      baseRef: 'codex/planning-provider-convergence-20260907',
      baseCommit: '1'.repeat(40),
      baseTree: '2'.repeat(40),
      headRef: 'codex/provider-external-acceptance-kit-v1-20260907',
      headCommit: '3'.repeat(40),
      headTree: '4'.repeat(40),
      prospectiveMergeCommit: '5'.repeat(40),
      prospectiveMergeTree: '6'.repeat(40),
      mergeParents: ['1'.repeat(40), '3'.repeat(40)],
    },
    providerSubject: {
      providerOwnerId: 'provider-owner-alpha',
      providerAccountId: 'provider-sandbox-account-alpha',
      sandboxAccount: true,
      credentialVersionSha256: digest,
      endpointSetSha256: digest,
      companionReleaseId: 'provider-companion-v1.0.0',
      companionExecutableSha256: digest,
      targetHostId: 'provider-target-host-alpha',
      targetHostProfileSha256: digest,
    },
    evidence: {
      sourceManifestSha256: digest,
      conformanceResultSha256: digest,
      quarantineResultSha256: digest,
      idempotencyRecoveryResultSha256: digest,
      revocationResultSha256: digest,
      evidenceIndexSha256: digest,
      retentionReceiptSha256: digest,
    },
    currentness: {
      observedAt: '2026-09-07T00:10:00Z',
      validUntil: '2026-09-07T01:10:00Z',
      revocationSnapshotSha256: digest,
      currentnessVerifierSha256: digest,
      liveRevalidationRequired: true,
    },
    decisions: [
      decision('provider_owner', 'one'),
      decision('evidence_owner', 'two'),
      decision('release_owner', 'three'),
    ],
    technicalCompanionAccepted: true,
    authority: {
      providerAuthorized: false,
      credentialCustodyEstablished: false,
      externalActionAuthorized: false,
      releaseAuthorized: false,
      submissionAuthorized: false,
      productionAuthorized: false,
      externalAuthorityClaimed: false,
    },
  };
}

function write(t, value, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-external-receipt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

function validate(instance, expectedStatus) {
  return spawnSync(
    'python3',
    [validator, '--schema', schema, '--instance', instance],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  );
}

test('technical external acceptance receipt satisfies the closed schema', (t) => {
  const result = validate(write(t, receipt(), 'valid.json'), 0);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('acceptance receipt cannot grant provider or production authority', (t) => {
  for (const [index, mutate] of [
    (value) => { value.authority.providerAuthorized = true; },
    (value) => { value.authority.credentialCustodyEstablished = true; },
    (value) => { value.authority.externalActionAuthorized = true; },
    (value) => { value.authority.releaseAuthorized = true; },
    (value) => { value.authority.submissionAuthorized = true; },
    (value) => { value.authority.productionAuthorized = true; },
    (value) => { value.authority.externalAuthorityClaimed = true; },
  ].entries()) {
    const candidate = structuredClone(receipt());
    mutate(candidate);
    const result = validate(write(t, candidate, `authority-${index}.json`), 1);
    assert.notEqual(result.status, 0, `${index}:${result.stdout}\n${result.stderr}`);
  }
});

test('all three independent decision roles are required in canonical order', (t) => {
  for (const [index, mutate] of [
    (value) => { value.decisions.pop(); },
    (value) => { [value.decisions[0], value.decisions[1]] = [value.decisions[1], value.decisions[0]]; },
    (value) => { value.decisions[1].role = 'provider_owner'; },
    (value) => { value.decisions[2].algorithm = 'fixture'; },
    (value) => { value.decisions[0].decision = 'approved'; },
  ].entries()) {
    const candidate = structuredClone(receipt());
    mutate(candidate);
    const result = validate(write(t, candidate, `decision-${index}.json`), 1);
    assert.notEqual(result.status, 0, `${index}:${result.stdout}\n${result.stderr}`);
  }
});

test('receipt subject, evidence and currentness remain closed', (t) => {
  for (const [index, mutate] of [
    (value) => { value.exactSubject.mergeParents.reverse(); },
    (value) => { value.exactSubject.headCommit += '\n'; },
    (value) => { delete value.evidence.retentionReceiptSha256; },
    (value) => { value.currentness.liveRevalidationRequired = false; },
    (value) => { value.providerSubject.sandboxAccount = false; },
    (value) => { value.unexpected = false; },
  ].entries()) {
    const candidate = structuredClone(receipt());
    mutate(candidate);
    const result = validate(write(t, candidate, `closed-${index}.json`), 1);
    assert.notEqual(result.status, 0, `${index}:${result.stdout}\n${result.stderr}`);
  }
});

test('checked-in receipt template is visibly unbound and schema-invalid', (t) => {
  const value = JSON.parse(fs.readFileSync(template, 'utf8'));
  assert.equal(value.kind, 'ProviderExternalAcceptanceReceiptTemplateV1');
  assert.equal(value.status, 'template_unbound');
  assert.equal(value.templateOnly, true);
  assert.equal(value.technicalCompanionAccepted, false);
  assert.equal(value.externalAcceptanceEligible, false);
  assert.ok(value.requiredBindings.length >= 30);
  assert.ok(Object.values(value.authority).every((entry) => entry === false));
  const result = validate(template, 1);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
