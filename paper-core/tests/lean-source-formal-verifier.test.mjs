import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLakeFormalVerifier } from '../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { analyzeLeanTypeContract, leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { buildFormalClaimContract } from '../../paper-domain/research/formal-claim-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'migration', 'fixtures', 'lean-adversarial');

const fixtureToolchainIdentity = Object.freeze({
  status: 'lean_toolchain_identity_verified',
  toolchain: 'leanprover/lean4:v4.30.0',
  leanExecutableHash: hashRecord('FixtureLeanExecutable', {}),
  lakeExecutableHash: hashRecord('FixtureLakeExecutable', {}),
  toolchainContentManifestHash: hashRecord('FixtureToolchainManifest', {}),
  toolchainRootMerkleHash: hashRecord('FixtureToolchainMerkle', {}),
  stdlibManifestHash: hashRecord('FixtureStdlibManifest', {}),
  runtimeLibraryManifestHash: hashRecord('FixtureRuntimeLibraryManifest', {}),
  leanToolchainContentIdentityHash: hashRecord('FixtureLeanToolchainIdentity', {}),
  blockers: [],
});
const fixtureToolchainIdentityProvider = Object.freeze({ inspect: () => fixtureToolchainIdentity });

function receipt(relative) {
  return { path: relative, hash: hashBytes(fs.readFileSync(path.join(fixtureRoot, relative))) };
}

function formalBinding({ claimId, theoremName, declaration, sourceFile = 'Adversarial.lean', proofObligations = [theoremName] }) {
  const formalClaimContract = buildFormalClaimContract({
    claimId,
    claimText: `The manuscript claim is formally represented by ${theoremName}.`,
    sourceLocator: 'manuscript.tex#claim',
    theoremName,
    theoremTypeHash: declaration.typeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations,
    manuscriptSourceIdentity: { path: 'manuscript.tex', byteStart: 0, byteEnd: 4, contentHash: 'sha256:claim', fileHash: 'sha256:paper' },
    semanticReview: {
      status: 'formal_semantic_review_verified',
      reviewerId: 'independent-formal-reviewer',
      authorId: 'formal-author',
      semanticEquivalenceVerified: true,
      reviewReceiptHash: hashRecord('FormalSemanticReviewReceipt', { claimId, theoremName }),
      reviewEnvelopeHash: 'sha256:envelope',
      reviewNodeId: 'review-node',
      reviewAttemptId: 'review-attempt',
      reviewAgentReceiptHash: 'sha256:review-agent',
      authorNodeId: 'author-node',
      authorAgentReceiptHash: 'sha256:author-agent',
      reviewedManuscriptHash: 'sha256:paper',
      reviewedWorkerPlanHash: 'sha256:plan',
    },
  });
  return {
    claimId,
    theoremName,
    sourceFile,
    expectedTypeHash: declaration.typeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations,
    manuscriptClaimHash: formalClaimContract.manuscriptClaimHash,
    formalClaimContract,
  };
}

test('Lean source parser derives conclusion-as-premise without caller annotations', () => {
  const declarations = leanSourceDeclarationRecords(fs.readFileSync(path.join(fixtureRoot, 'Adversarial.lean'), 'utf8'));
  const adversarial = declarations.find((item) => item.name === 'conclusionFromPremise');
  assert.ok(adversarial);
  assert.equal(adversarial.conclusion, 'P');
  assert.ok(adversarial.premises.includes('P'));
  assert.equal(adversarial.conclusionAssumedAsPremise, true);
  const wrapped = declarations.find((item) => item.name === 'wrappedConclusionFromPremise');
  assert.ok(wrapped);
  assert.equal(wrapped.conclusion, 'P');
  assert.ok(wrapped.premises.includes('P ∧ True'));
  assert.equal(wrapped.conclusionAssumedAsPremise, true);
  const vacuous = declarations.find((item) => item.name === 'vacuousTrue');
  assert.equal(vacuous.conclusion, 'True');
  assert.equal(vacuous.vacuous, true);
});

test('real Lake build cannot certify a theorem whose source assumes its conclusion', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const commandRunner = {
    run(spec) {
      const execution = spawnSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env } });
      const payload = { executable: spec.executable, args: spec.args, status: execution.status, stdout: execution.stdout || '', stderr: execution.stderr || '' };
      return { ...payload, ok: execution.status === 0, receiptHash: hashRecord('LeanFixtureCommandReceipt', payload), blockers: execution.status === 0 ? [] : ['command_failed'] };
    },
  };
  const declarations = leanSourceDeclarationRecords(
    fs.readFileSync(path.join(fixtureRoot, 'Adversarial.lean'), 'utf8'),
  );
  const declaration = declarations.find((item) => item.name === 'conclusionFromPremise');
  const wrappedDeclaration = declarations.find((item) => item.name === 'wrappedConclusionFromPremise');
  const verifier = createLakeFormalVerifier({ projectRoot: fixtureRoot, commandRunner, toolchainIdentityProvider: fixtureToolchainIdentityProvider });
  const result = await verifier.verify({
    expectedInputs: [receipt('Adversarial.lean'), receipt('Audit.lean')],
    claimBindings: [
      {
        ...formalBinding({ claimId: 'claim-adversarial', theoremName: 'conclusionFromPremise', declaration }),
        unconditional: true,
        conditional: false,
        conclusionAssumedAsPremise: false,
      },
      {
        ...formalBinding({
          claimId: 'claim-wrapped-adversarial',
          theoremName: 'wrappedConclusionFromPremise',
          declaration: wrappedDeclaration,
        }),
        unconditional: true,
        conditional: false,
        conclusionAssumedAsPremise: false,
      },
    ],
  });
  assert.equal(result.status, 'formal_claim_binding_blocked', `${JSON.stringify(result, null, 2)}`);
  assert.ok(result.blockers.includes('claim-adversarial:target_conclusion_assumed_as_premise'));
  assert.ok(result.blockers.includes('claim-wrapped-adversarial:target_conclusion_assumed_as_premise'));
  assert.equal(result.claimBindingReport.bindings[0].sourceStatementHash, declaration.statementHash);
});

test('system-owned obligation type audit rejects semantically wrapped conclusion premises', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const commandRunner = {
    run(spec) {
      const execution = spawnSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env } });
      const payload = { executable: spec.executable, args: spec.args, status: execution.status, stdout: execution.stdout || '', stderr: execution.stderr || '' };
      return { ...payload, ok: execution.status === 0, receiptHash: hashRecord('LeanFixtureCommandReceipt', payload), blockers: execution.status === 0 ? [] : ['command_failed'] };
    },
  };
  const declaration = leanSourceDeclarationRecords(
    fs.readFileSync(path.join(fixtureRoot, 'Adversarial.lean'), 'utf8'),
  ).find((item) => item.name === 'implicationWrappedConclusionFromPremise');
  assert.equal(declaration.conclusionAssumedAsPremise, false, 'syntactic heuristic alone must not be the authority');
  const verifier = createLakeFormalVerifier({
    projectRoot: fixtureRoot,
    commandRunner,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
  });
  const result = await verifier.verify({
    expectedInputs: [receipt('Adversarial.lean'), receipt('Audit.lean')],
    claimBindings: [formalBinding({
      claimId: 'claim-obligation-type-echo',
      theoremName: declaration.name,
      declaration,
      proofObligations: ['length_filter_le'],
    })],
  });
  assert.equal(result.status, 'formal_certificate_blocked', JSON.stringify(result, null, 2));
  assert.ok(result.blockers.includes('lake_build_failed'));
});

test('real Lake build cannot promote a vacuous True theorem', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const commandRunner = {
    run(spec) {
      const execution = spawnSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env } });
      const payload = { executable: spec.executable, args: spec.args, status: execution.status, stdout: execution.stdout || '', stderr: execution.stderr || '' };
      return { ...payload, ok: execution.status === 0, receiptHash: hashRecord('LeanFixtureCommandReceipt', payload), blockers: execution.status === 0 ? [] : ['command_failed'] };
    },
  };
  const declaration = leanSourceDeclarationRecords(fs.readFileSync(path.join(fixtureRoot, 'Adversarial.lean'), 'utf8')).find((item) => item.name === 'vacuousTrue');
  const verifier = createLakeFormalVerifier({ projectRoot: fixtureRoot, commandRunner, toolchainIdentityProvider: fixtureToolchainIdentityProvider });
  const result = await verifier.verify({
    expectedInputs: [receipt('Adversarial.lean'), receipt('Audit.lean')],
    claimBindings: [formalBinding({ claimId: 'claim-vacuous', theoremName: 'vacuousTrue', declaration })],
  });
  assert.equal(result.status, 'formal_claim_binding_blocked', `${JSON.stringify(result, null, 2)}`);
  assert.ok(result.blockers.some((item) => item.endsWith('target_theorem_vacuous_true')));
});

test('system-generated axiom audit rejects a real theorem backed by an undeclared False axiom', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lake-axiom-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'lakefile.lean'), [
    'import Lake', 'open Lake DSL', 'package heptaAxiomAudit where',
    '@[default_target]', 'lean_lib Main where', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n');
  fs.writeFileSync(path.join(root, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0', packagesDir: '.lake/packages', packages: [], name: 'heptaAxiomAudit', lakeDir: '.lake',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'Main.lean'), 'axiom falseProof : False\ntheorem badTheorem : False := falseProof\n');
  const declaration = leanSourceDeclarationRecords(fs.readFileSync(path.join(root, 'Main.lean'), 'utf8'))
    .find((item) => item.name === 'badTheorem');
  assert.ok(declaration);
  const executionRoots = [];
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
    commandRunnerFactory(executionRoot) {
      executionRoots.push(executionRoot);
      assert.equal(fs.existsSync(path.join(executionRoot, '.lake')), false, 'fresh verifier input must not reuse caller build state');
      return {
        run(spec) {
          const execution = spawnSync(spec.executable, spec.args, {
            cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env },
          });
          const payload = {
            executable: spec.executable, args: spec.args, status: execution.status,
            stdout: execution.stdout || '', stderr: execution.stderr || '',
          };
          return {
            ...payload, ok: execution.status === 0,
            receiptHash: hashRecord('LeanAxiomAuditCommandReceipt', payload),
            blockers: execution.status === 0 ? [] : ['command_failed'],
          };
        },
      };
    },
  });
  const result = await verifier.verify({
    claimBindings: [formalBinding({
      claimId: 'claim-false', theoremName: 'badTheorem', declaration, sourceFile: 'Main.lean',
    })],
  });
  assert.equal(result.status, 'formal_claim_binding_blocked', JSON.stringify(result, null, 2));
  assert.ok(result.blockers.includes('claim-false:target_theorem_uses_unapproved_axioms'));
  assert.deepEqual(result.claimBindingReport.bindings[0].axioms, ['falseProof']);
  assert.equal(executionRoots.length, 1);
  assert.notEqual(executionRoots[0], root);
  assert.equal(fs.existsSync(executionRoots[0]), false, 'fresh verifier snapshot must be removed after use');
});

test('formal audit explicitly builds the bound source and rejects default-target stdout spoofing', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lake-default-target-spoof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'lakefile.lean'), [
    'import Lake', 'open Lake DSL', 'package heptaDefaultTargetSpoof where',
    '@[default_target]', 'lean_lib Spoof where', 'lean_lib Main where', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n');
  fs.writeFileSync(path.join(root, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0', packagesDir: '.lake/packages', packages: [], name: 'heptaDefaultTargetSpoof', lakeDir: '.lake',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'Spoof.lean'), [
    '#eval IO.println "badTheorem : False"',
    '#eval IO.println "\'badTheorem\' does not depend on any axioms"',
    '',
  ].join('\n'));
  const source = 'axiom falseProof : False\ntheorem badTheorem : False := falseProof\n';
  fs.writeFileSync(path.join(root, 'Main.lean'), source);
  const declaration = leanSourceDeclarationRecords(source).find((item) => item.name === 'badTheorem');
  const invocations = [];
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
    commandRunnerFactory() {
      return {
        run(spec) {
          invocations.push(spec.args);
          const execution = spawnSync(spec.executable, spec.args, {
            cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env },
          });
          const payload = {
            executable: spec.executable, args: spec.args, status: execution.status,
            stdout: execution.stdout || '', stderr: execution.stderr || '',
          };
          return {
            ...payload, ok: execution.status === 0,
            receiptHash: hashRecord('LeanExplicitSourceAuditCommandReceipt', payload),
            blockers: execution.status === 0 ? [] : ['command_failed'],
          };
        },
      };
    },
  });
  const result = await verifier.verify({
    claimBindings: [formalBinding({
      claimId: 'claim-default-target-spoof', theoremName: 'badTheorem', declaration, sourceFile: 'Main.lean',
    })],
  });
  assert.deepEqual(invocations, [['build', 'Main.lean']]);
  assert.equal(result.status, 'formal_claim_binding_blocked', JSON.stringify(result, null, 2));
  assert.ok(result.blockers.includes('claim-default-target-spoof:target_theorem_uses_unapproved_axioms'));
  assert.deepEqual(result.claimBindingReport.bindings[0].axioms, ['falseProof']);
});

test('Lean elaboration defeats a theorem-shaped string decoy and binds the unique real declaration', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lake-string-decoy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'lakefile.lean'), [
    'import Lake', 'open Lake DSL', 'package heptaStringDecoy where',
    '@[default_target]', 'lean_lib Main where', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n');
  fs.writeFileSync(path.join(root, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0', packagesDir: '.lake/packages', packages: [], name: 'heptaStringDecoy', lakeDir: '.lake',
  }, null, 2)}\n`);
  const source = 'def decoy : String := "theorem target : False := by trivial"\ntheorem target (h : False) : False := h\n';
  fs.writeFileSync(path.join(root, 'Main.lean'), source);
  const declarations = leanSourceDeclarationRecords(source).filter((item) => item.name === 'target');
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].conclusionAssumedAsPremise, true);
  const fakeType = analyzeLeanTypeContract(': False');
  const fakeDeclaration = {
    ...fakeType,
    statement: 'theorem target : False',
    statementHash: hashBytes(Buffer.from('theorem target : False')),
  };
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
    commandRunnerFactory() {
      return {
        run(spec) {
          const execution = spawnSync(spec.executable, spec.args, {
            cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env },
          });
          const payload = {
            executable: spec.executable, args: spec.args, status: execution.status,
            stdout: execution.stdout || '', stderr: execution.stderr || '',
          };
          return {
            ...payload, ok: execution.status === 0,
            receiptHash: hashRecord('LeanStringDecoyCommandReceipt', payload),
            blockers: execution.status === 0 ? [] : ['command_failed'],
          };
        },
      };
    },
  });
  const result = await verifier.verify({
    claimBindings: [formalBinding({
      claimId: 'claim-decoy', theoremName: 'target', declaration: fakeDeclaration, sourceFile: 'Main.lean',
    })],
  });
  assert.equal(result.status, 'formal_claim_binding_blocked', JSON.stringify(result, null, 2));
  assert.ok(result.blockers.includes('claim-decoy:target_theorem_type_hash_mismatch'));
  assert.ok(result.blockers.includes('claim-decoy:target_theorem_source_statement_hash_mismatch'));
  assert.ok(result.blockers.includes('claim-decoy:target_conclusion_assumed_as_premise'));
});

test('Lake replay rejects an unlisted local dependency before re-execution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lake-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['lakefile.lean', 'lean-toolchain', 'lake-manifest.json']) fs.copyFileSync(path.join(fixtureRoot, name), path.join(root, name));
  fs.writeFileSync(path.join(root, 'Main.lean'), 'theorem replaySafe : 1 = 1 := by rfl\n');
  const commandRunner = { run: async () => ({ ok: true, stdout: '', stderr: '', receiptHash: 'sha256:fixture' }) };
  const verifier = createLakeFormalVerifier({ projectRoot: root, commandRunner, toolchainIdentityProvider: fixtureToolchainIdentityProvider });
  const certificate = await verifier.verify();
  assert.equal(certificate.status, 'formal_build_verified');
  fs.writeFileSync(path.join(root, 'Injected.lean'), 'axiom falseProof : False\n');
  const replay = await verifier.replay({ certificateBundle: certificate });
  assert.equal(replay.status, 'formal_certificate_replay_blocked');
  assert.ok(replay.blockers.includes('formal_project_unlisted_input:Injected.lean'));
});

test('Lake replay uses a fresh snapshot and rejects bundle, toolchain, or executable identity forgery', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lake-replay-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['lakefile.lean', 'lean-toolchain', 'lake-manifest.json']) fs.copyFileSync(path.join(fixtureRoot, name), path.join(root, name));
  fs.writeFileSync(path.join(root, 'Adversarial.lean'), 'theorem replayIdentity : 1 = 1 := by rfl\n');
  const executionRoots = [];
  const commandRunnerFactory = (executionRoot) => {
    executionRoots.push(executionRoot);
    assert.equal(fs.existsSync(path.join(executionRoot, '.lake')), false);
    return {
      async run() {
        return {
          ok: true, stdout: '', stderr: '', receiptHash: 'sha256:trusted-execution-receipt',
          runnerId: 'trusted-lake-runner', backend: 'host', runtimeIdentityType: 'host-executable',
          runtimeIdentityHash: 'sha256:runtime', runtimeExecutableSnapshotHash: 'sha256:lake-executable',
          runtimeExecutableInvocationPath: '/trusted/lake', containerImageDigest: null,
        };
      },
    };
  };
  const verifier = createLakeFormalVerifier({ projectRoot: root, commandRunnerFactory, toolchainIdentityProvider: fixtureToolchainIdentityProvider });
  const certificate = await verifier.verify();
  assert.equal(certificate.status, 'formal_build_verified');
  const replay = await verifier.replay({ certificateBundle: certificate });
  assert.equal(replay.status, 'formal_build_replay_verified');
  assert.equal(executionRoots.length, 2);
  assert.notEqual(executionRoots[0], executionRoots[1]);
  assert.ok(executionRoots.every((candidate) => !fs.existsSync(candidate)));

  const invalidHash = await verifier.replay({ certificateBundle: { ...certificate, certificateBundleHash: 'sha256:forged' } });
  assert.deepEqual(invalidHash.blockers, ['formal_certificate_bundle_hash_invalid']);

  const { certificateBundleHash: _identityHash, ...identityPayload } = certificate;
  const forgedIdentityPayload = {
    ...identityPayload,
    executionIdentity: { ...identityPayload.executionIdentity, runtimeExecutableSnapshotHash: 'sha256:forged-executable' },
  };
  const forgedIdentity = {
    ...forgedIdentityPayload,
    certificateBundleHash: hashRecord('FormalCertificateBundle', forgedIdentityPayload),
  };
  assert.ok((await verifier.replay({ certificateBundle: forgedIdentity })).blockers.includes('formal_replay_authority_identity_mismatch'));

  const forgedToolchainPayload = { ...identityPayload, toolchain: 'leanprover/lean4:v0.0.0' };
  const forgedToolchain = {
    ...forgedToolchainPayload,
    certificateBundleHash: hashRecord('FormalCertificateBundle', forgedToolchainPayload),
  };
  assert.ok((await verifier.replay({ certificateBundle: forgedToolchain })).blockers.includes('formal_replay_authority_identity_mismatch'));
});

test('Lake verifier rejects caller-supplied declaration and axiom authority', async () => {
  const verifier = createLakeFormalVerifier({ projectRoot: fixtureRoot, commandRunner: { run: async () => ({ ok: true }) }, toolchainIdentityProvider: fixtureToolchainIdentityProvider });
  assert.deepEqual((await verifier.verify({ declarationReports: [] })).blockers, ['formal_verifier_caller_authority_override_forbidden']);
  assert.deepEqual((await verifier.verify({ allowedAxioms: [] })).blockers, ['formal_verifier_caller_authority_override_forbidden']);
  assert.deepEqual((await verifier.verify({ claimBindings: [{ auditFile: 'Audit.lean' }] })).blockers, ['formal_verifier_caller_audit_override_forbidden']);
});
