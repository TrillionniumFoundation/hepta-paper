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

function temporaryLakeProject(t, {
  sourceFile = 'Main.lean',
  source = 'theorem simpleIdentity : 1 = 1 := by rfl\n',
  toolchain = 'leanprover/lean4:v4.30.0',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lake-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'lakefile.lean'), [
    'import Lake',
    'open Lake DSL',
    'package heptaLakeCoverage where',
    '@[default_target]',
    'lean_lib Main where',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'lean-toolchain'), `${toolchain}\n`);
  fs.writeFileSync(path.join(root, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0', packagesDir: '.lake/packages', packages: [],
    name: 'heptaLakeCoverage', lakeDir: '.lake',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, sourceFile), source);
  return root;
}

function trustedExecution({
  ok = true,
  stdout = '',
  stderr = '',
  blockers = [],
  identitySuffix = 'fixture',
} = {}) {
  return {
    ok,
    stdout,
    stderr,
    blockers,
    receiptHash: ok ? `sha256:execution-${identitySuffix}` : null,
    runnerId: `lake-runner-${identitySuffix}`,
    backend: 'host',
    runtimeIdentityType: 'host-executable',
    runtimeIdentityHash: `sha256:runtime-${identitySuffix}`,
    runtimeExecutableSnapshotHash: `sha256:executable-${identitySuffix}`,
    runtimeExecutableInvocationPath: '/trusted/lake',
    containerImageDigest: null,
    isolation: { kind: 'fixture-isolation' },
  };
}

function resignFormalCertificate(certificate, mutate) {
  const { certificateBundleHash: _ignored, ...payload } = certificate;
  const nextPayload = mutate(payload);
  return {
    ...nextPayload,
    certificateBundleHash: hashRecord('FormalCertificateBundle', nextPayload),
  };
}

function formalProjectManifestHash(projectFiles) {
  return hashRecord('FormalProjectManifest', projectFiles.map(({
    path: filePath, sourcePath, projectPath, role, hash, bytes, posixMode,
  }) => ({
    path: filePath,
    sourcePath: sourcePath || filePath,
    projectPath: projectPath ?? filePath,
    role: role || 'project',
    hash,
    bytes,
    posixMode,
  })));
}

function dynamicFormalBinding({
  declaration,
  allowedImports = ['Init'],
  typeSource = '∀ n : Nat, n = n',
  claimId = 'claim-dynamic-identity',
  sourceFile = 'Main.lean',
}) {
  const leanTypeSourceHash = hashBytes(Buffer.from(typeSource, 'utf8'));
  const dynamicAuthority = {
    dynamicFormalClaimSeedHash: hashRecord('DynamicFormalClaimSeedFixture', {}),
    leanDeclarationName: declaration.name,
    leanTypeSource: typeSource,
    leanTypeSourceHash,
    leanNormalizedTypeHash: declaration.typeHash,
    allowedImports,
    formalClaimCapabilityScopeManifestHash: hashRecord('FormalClaimCapabilityScopeFixture', {}),
    formalClaimGeneratorReceiptHash: hashRecord('FormalClaimGeneratorFixture', {}),
  };
  const base = formalBinding({
    claimId,
    theoremName: declaration.name,
    declaration,
    sourceFile,
  });
  const formalClaimContract = buildFormalClaimContract({
    claimId: base.claimId,
    claimText: `The manuscript claim is formally represented by ${declaration.name}.`,
    sourceLocator: 'manuscript.tex#claim',
    theoremName: declaration.name,
    theoremTypeHash: declaration.typeHash,
    sourceStatementHash: declaration.statementHash,
    proofObligations: [declaration.name],
    manuscriptSourceIdentity: {
      path: 'manuscript.tex', byteStart: 0, byteEnd: 4,
      contentHash: 'sha256:claim', fileHash: 'sha256:paper',
    },
    dynamicFormalClaimAuthority: dynamicAuthority,
    semanticReview: {
      status: 'formal_semantic_review_verified',
      reviewerId: 'independent-formal-reviewer',
      authorId: 'formal-author',
      semanticEquivalenceVerified: true,
      reviewReceiptHash: hashRecord('FormalSemanticReviewReceipt', { claimId: base.claimId }),
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
  return { ...base, formalClaimContract };
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
  assert.equal(result.projectFiles.some((file) => file.path.startsWith('.lake/build/')), false);
  assert.equal(result.projectFiles.some((file) => file.path.startsWith('.lake/config/')), false);
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

test('Lake verifier enumerates preflight and dynamic formal authority fail-closed branches', async (t) => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lake-empty-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  const blockedPreflight = await createLakeFormalVerifier({
    projectRoot: emptyRoot,
    commandRunner: { run: async () => trustedExecution() },
  }).verify({
    expectedInputs: [{ path: 'Missing.lean', hash: 'sha256:missing' }],
  });
  assert.equal(blockedPreflight.status, 'formal_verifier_blocked');
  for (const blocker of [
    'formal_project_file_missing:lakefile.lean',
    'formal_project_file_missing:lean-toolchain',
    'formal_project_file_missing:lake-manifest.json',
    'formal_input_missing:Missing.lean',
    'formal_project_pinned_toolchain_invalid',
    'formal_toolchain_runtime_identity_provider_required',
  ]) assert.ok(blockedPreflight.blockers.includes(blocker), blocker);

  const source = [
    'import Init',
    'theorem dynamicIdentity : ∀ n : Nat, n = n := by',
    '  intro n',
    '  rfl',
    '',
  ].join('\n');
  const root = temporaryLakeProject(t, { source });
  const declaration = leanSourceDeclarationRecords(source)
    .find((item) => item.name === 'dynamicIdentity');
  assert.ok(declaration);

  const invalidIdentityProvider = Object.freeze({
    inspect: () => ({
      status: 'lean_toolchain_identity_blocked',
      toolchain: 'leanprover/lean4:v0.0.0',
      blockers: ['fixture_toolchain_identity_blocked'],
    }),
  });
  const wrongExpectedHash = await createLakeFormalVerifier({
    projectRoot: root,
    commandRunner: { run: async () => trustedExecution() },
    toolchainIdentityProvider: invalidIdentityProvider,
  }).verify({ expectedInputs: [{ path: 'Main.lean', hash: 'sha256:wrong' }] });
  for (const blocker of [
    'formal_input_hash_mismatch:Main.lean',
    'formal_toolchain_runtime_identity_invalid',
    'fixture_toolchain_identity_blocked',
    'formal_toolchain_runtime_version_mismatch',
  ]) assert.ok(wrongExpectedHash.blockers.includes(blocker), blocker);
  const missingExpectedPath = await createLakeFormalVerifier({
    projectRoot: root,
    commandRunner: { run: async () => trustedExecution() },
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
  }).verify({ expectedInputs: [{ hash: 'sha256:missing-path' }] });
  assert.ok(missingExpectedPath.blockers.includes('formal_input_missing:undefined'));
  const identityWithoutDetailedBlockers = await createLakeFormalVerifier({
    projectRoot: root,
    commandRunner: { run: async () => trustedExecution() },
    toolchainIdentityProvider: {
      inspect: () => ({
        status: 'lean_toolchain_identity_blocked',
        toolchain: 'leanprover/lean4:v4.30.0',
      }),
    },
  }).verify();
  assert.ok(identityWithoutDetailedBlockers.blockers.includes('formal_toolchain_runtime_identity_invalid'));

  const dynamicBinding = dynamicFormalBinding({ declaration });
  const auditStdout = [
    `dynamicIdentity : ∀ n : Nat, n = n`,
    "'dynamicIdentity' does not depend on any axioms",
    '',
  ].join('\n');
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    commandRunner: { run: async () => trustedExecution({ stdout: auditStdout }) },
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
  });
  const verified = await verifier.verify({ claimBindings: [dynamicBinding] });
  assert.equal(verified.status, 'formal_claim_verified', JSON.stringify(verified, null, 2));

  const authority = dynamicBinding.formalClaimContract.dynamicFormalClaimAuthority;
  const mutateAuthority = (mutate, bindingMutate = (value) => value) => bindingMutate({
    ...dynamicBinding,
    formalClaimContract: {
      ...dynamicBinding.formalClaimContract,
      dynamicFormalClaimAuthority: mutate({ ...authority }),
    },
  });
  const invalidBindings = [
    mutateAuthority((value) => ({ ...value, leanDeclarationName: 'otherDeclaration' })),
    mutateAuthority((value) => ({ ...value, leanTypeSource: 'by exact True.intro' })),
    mutateAuthority((value) => ({ ...value, leanTypeSourceHash: 'sha256:wrong' })),
    mutateAuthority((value) => ({ ...value, leanNormalizedTypeHash: 'sha256:wrong' })),
    mutateAuthority((value) => value, (binding) => ({ ...binding, expectedTypeHash: 'sha256:wrong' })),
    mutateAuthority((value) => value, (binding) => ({
      ...binding,
      formalClaimContract: { ...binding.formalClaimContract, theoremName: 'otherDeclaration' },
    })),
    mutateAuthority((value) => value, (binding) => ({
      ...binding,
      formalClaimContract: { ...binding.formalClaimContract, theoremTypeHash: 'sha256:wrong' },
    })),
    { ...dynamicBinding, sourceFile: '../Main.lean' },
    { ...dynamicBinding, theoremName: 'not a theorem name' },
    {
      ...dynamicBinding,
      proofObligations: [],
      proofObligationContracts: [],
      proofObligationMappings: [],
    },
  ];
  for (const binding of invalidBindings) {
    const result = await verifier.verify({ claimBindings: [binding] });
    assert.ok(result.blockers.includes('formal_system_audit_contract_invalid'), JSON.stringify(result));
  }

  const missingDynamicSource = await verifier.verify({
    claimBindings: [{ ...dynamicBinding, sourceFile: 'Missing.lean' }],
  });
  assert.ok(missingDynamicSource.blockers.includes('formal_dynamic_claim_source_invalid:claim-dynamic-identity'));
  const anonymousMissingDynamicSource = await verifier.verify({
    claimBindings: [{ ...dynamicBinding, claimId: null, sourceFile: 'Missing.lean' }],
  });
  assert.ok(anonymousMissingDynamicSource.blockers.includes('formal_dynamic_claim_source_invalid:missing'));

  const disallowedImportBinding = mutateAuthority((value) => ({
    ...value,
    allowedImports: ['Mathlib'],
  }));
  const disallowedImport = await verifier.verify({ claimBindings: [disallowedImportBinding] });
  assert.ok(disallowedImport.blockers.includes('formal_dynamic_claim_import_not_allowed:claim-dynamic-identity'));
  const anonymousDisallowedImport = await verifier.verify({
    claimBindings: [{ ...disallowedImportBinding, claimId: null }],
  });
  assert.ok(anonymousDisallowedImport.blockers.includes('formal_dynamic_claim_import_not_allowed:missing'));

  const alternateTypeSource = '(n : Nat) → n = n';
  const conflictingBinding = dynamicFormalBinding({
    declaration: {
      ...declaration,
      typeHash: analyzeLeanTypeContract(alternateTypeSource).typeHash,
    },
    typeSource: alternateTypeSource,
  });
  const conflict = await verifier.verify({ claimBindings: [dynamicBinding, conflictingBinding] });
  assert.ok(conflict.blockers.includes('formal_system_audit_contract_invalid'));
});

test('Lake verifier covers runner, snapshot, audit-output, and declaration binding failures', async (t) => {
  const source = [
    'theorem simpleIdentity : 1 = 1 := by rfl',
    '',
  ].join('\n');
  const root = temporaryLakeProject(t, { source });
  const declaration = leanSourceDeclarationRecords(source)
    .find((item) => item.name === 'simpleIdentity');
  const binding = formalBinding({
    claimId: 'claim-simple-identity', theoremName: declaration.name, declaration,
    sourceFile: 'Main.lean',
  });
  const verifierOptions = {
    projectRoot: root,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
  };

  const snapshotFailure = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: { run: async () => trustedExecution() },
    projectSnapshotRepository: {
      materialize() { throw new Error('fixture_snapshot_materialization_failed'); },
    },
  }).verify();
  assert.equal(snapshotFailure.status, 'formal_certificate_blocked');
  assert.ok(snapshotFailure.blockers.includes('fixture_snapshot_materialization_failed'));
  const anonymousSnapshotFailure = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: { run: async () => trustedExecution() },
    projectSnapshotRepository: { materialize() { throw {}; } },
  }).verify();
  assert.ok(anonymousSnapshotFailure.blockers.includes('formal_fresh_project_execution_failed'));

  const runnerFailure = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: { async run() { throw new Error('fixture_runner_failed'); } },
  }).verify();
  assert.equal(runnerFailure.status, 'formal_certificate_blocked');
  assert.ok(runnerFailure.blockers.includes('fixture_runner_failed'));

  const explicitFailure = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: {
      run: async () => ({ ok: false, stderr: null, receiptHash: null }),
    },
  }).verify();
  assert.equal(explicitFailure.status, 'formal_certificate_blocked');
  assert.deepEqual(explicitFailure.blockers, ['lake_build_failed']);

  for (const afterIdentity of [
    { ...fixtureToolchainIdentity, status: 'lean_toolchain_identity_blocked' },
    {
      ...fixtureToolchainIdentity,
      leanToolchainContentIdentityHash: hashRecord('ChangedLeanToolchainIdentity', {}),
    },
  ]) {
    let inspections = 0;
    const changingProvider = {
      inspect() {
        inspections += 1;
        return inspections === 1 ? fixtureToolchainIdentity : afterIdentity;
      },
    };
    const changed = await createLakeFormalVerifier({
      ...verifierOptions,
      commandRunner: { run: async () => ({ ...trustedExecution(), blockers: undefined }) },
      toolchainIdentityProvider: changingProvider,
    }).verify();
    assert.equal(changed.status, 'formal_certificate_blocked');
    assert.ok(changed.blockers.includes('formal_toolchain_changed_during_execution'));
  }

  const auditExecutions = [
    trustedExecution({
      stdout: [
        'simpleIdentity : 1 = 1',
        'simpleIdentity : 1 = 1',
        "'simpleIdentity' does not depend on any axioms",
        "'simpleIdentity' does not depend on any axioms",
      ].join('\n'),
      stderr: "declaration uses 'sorry'\nadmit",
      identitySuffix: 'ambiguous',
    }),
    trustedExecution({
      stdout: [
        'warning: Main.lean:1:1: simpleIdentity : 1 = 1',
        "'simpleIdentity' depends on axioms: [Classical.choice, propext]",
      ].join('\n'),
      stderr: '',
      identitySuffix: 'axioms',
    }),
    trustedExecution({ stdout: null, stderr: null, identitySuffix: 'empty-audit' }),
  ];
  for (const execution of auditExecutions) {
    const result = await createLakeFormalVerifier({
      ...verifierOptions,
      commandRunner: { run: async () => execution },
    }).verify({ claimBindings: [binding] });
    assert.equal(result.status, 'formal_claim_binding_blocked');
  }

  const ghostDeclaration = { ...declaration, name: 'ghostIdentity' };
  const ghostBinding = formalBinding({
    claimId: 'claim-ghost-identity',
    theoremName: ghostDeclaration.name,
    declaration: ghostDeclaration,
    sourceFile: 'Main.lean',
  });
  const missingDeclaration = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: { run: async () => trustedExecution() },
  }).verify({ claimBindings: [ghostBinding] });
  assert.equal(missingDeclaration.status, 'formal_claim_binding_blocked');
  assert.equal(missingDeclaration.claimBindingReport.status, 'formal_claim_binding_blocked');

  const missingSource = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: { run: async () => trustedExecution() },
  }).verify({ claimBindings: [{ ...binding, sourceFile: 'Missing.lean' }] });
  assert.equal(missingSource.status, 'formal_claim_binding_blocked');

  const obligationAlias = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: {
      run: async () => trustedExecution({
        stdout: [
          'simpleIdentity : 1 = 1',
          "'simpleIdentity' does not depend on any axioms",
        ].join('\n'),
      }),
    },
  }).verify({
    claimBindings: [{
      ...binding,
      proofObligations: undefined,
      obligationNames: binding.proofObligations,
    }],
  });
  assert.ok(['formal_claim_verified', 'formal_claim_binding_blocked'].includes(obligationAlias.status));

  const multiSource = [
    'import Init',
    'theorem dynamicAlpha : ∀ n : Nat, n = n := by intro n; rfl',
    'theorem dynamicBeta : ∀ n : Nat, n = n := by intro n; rfl',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'Main.lean'), multiSource);
  const secondSource = 'import Init\ntheorem dynamicGamma : ∀ n : Nat, n = n := by intro n; rfl\n';
  fs.writeFileSync(path.join(root, 'Second.lean'), secondSource);
  const mainDeclarations = leanSourceDeclarationRecords(multiSource);
  const gamma = leanSourceDeclarationRecords(secondSource)[0];
  const sortedBindings = [
    dynamicFormalBinding({
      declaration: mainDeclarations.find((item) => item.name === 'dynamicBeta'),
      claimId: 'claim-dynamic-beta',
    }),
    dynamicFormalBinding({
      declaration: mainDeclarations.find((item) => item.name === 'dynamicAlpha'),
      claimId: 'claim-dynamic-alpha',
    }),
    dynamicFormalBinding({
      declaration: gamma,
      claimId: 'claim-dynamic-gamma',
      sourceFile: 'Second.lean',
    }),
  ];
  const sortedAudit = [
    'dynamicAlpha : ∀ n : Nat, n = n',
    "'dynamicAlpha' does not depend on any axioms",
    'dynamicBeta : ∀ n : Nat, n = n',
    "'dynamicBeta' does not depend on any axioms",
    'dynamicGamma : ∀ n : Nat, n = n',
    "'dynamicGamma' does not depend on any axioms",
  ].join('\n');
  const sorted = await createLakeFormalVerifier({
    ...verifierOptions,
    commandRunner: { run: async () => trustedExecution({ stdout: sortedAudit }) },
  }).verify({ claimBindings: sortedBindings });
  assert.equal(sorted.status, 'formal_claim_verified', JSON.stringify(sorted, null, 2));
  assert.deepEqual(sorted.auditTargets, ['Main.lean', 'Second.lean']);
});

test('immutable Lake audit rejects mixed runtime identities across source-scoped invocations', async (t) => {
  const mainSource = [
    'import Init',
    'theorem immutableAlpha : ∀ n : Nat, n = n := by intro n; rfl',
    '',
  ].join('\n');
  const secondSource = [
    'import Init',
    'theorem immutableBeta : ∀ n : Nat, n = n := by intro n; rfl',
    '',
  ].join('\n');
  const root = temporaryLakeProject(t, { source: mainSource });
  fs.writeFileSync(path.join(root, 'Second.lean'), secondSource);
  const alpha = leanSourceDeclarationRecords(mainSource)[0];
  const beta = leanSourceDeclarationRecords(secondSource)[0];
  const bindings = [
    dynamicFormalBinding({
      declaration: alpha,
      claimId: 'claim-immutable-alpha',
      sourceFile: 'Main.lean',
    }),
    dynamicFormalBinding({
      declaration: beta,
      claimId: 'claim-immutable-beta',
      sourceFile: 'Second.lean',
    }),
  ];
  const invocationTargets = [];
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    requireImmutableExecutionClosure: true,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
    commandRunnerFactory: () => Object.freeze({
      async run(spec) {
        const target = spec.args.at(-1);
        invocationTargets.push(target);
        const theoremName = target === 'Main.lean'
          ? 'immutableAlpha'
          : 'immutableBeta';
        return trustedExecution({
          stdout: [
            `${theoremName} : ∀ n : Nat, n = n`,
            `'${theoremName}' does not depend on any axioms`,
          ].join('\n'),
          identitySuffix: theoremName,
        });
      },
    }),
  });
  const result = await verifier.verify({ claimBindings: bindings });
  assert.equal(result.status, 'formal_certificate_blocked');
  assert.deepEqual(invocationTargets, ['Main.lean', 'Second.lean']);
  assert.ok(result.formalProjectSnapshotSealReceiptHash);
  assert.ok(result.blockers.includes(
    'formal_immutable_audit_runtime_identity_mismatch',
  ));

  const stableInvocationTargets = [];
  const stableVerifier = createLakeFormalVerifier({
    projectRoot: root,
    requireImmutableExecutionClosure: true,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
    commandRunnerFactory: () => Object.freeze({
      async run(spec) {
        const target = spec.args.at(-1);
        stableInvocationTargets.push(target);
        const theoremName = target === 'Main.lean'
          ? 'immutableAlpha'
          : 'immutableBeta';
        return trustedExecution({
          stdout: [
            `${theoremName} : ∀ n : Nat, n = n`,
            `'${theoremName}' does not depend on any axioms`,
          ].join('\n'),
          identitySuffix: 'immutable-stable-runtime',
        });
      },
    }),
  });
  const stable = await stableVerifier.verify({ claimBindings: bindings });
  assert.equal(stable.status, 'formal_claim_verified', JSON.stringify(stable));
  assert.deepEqual(stableInvocationTargets, ['Main.lean', 'Second.lean']);
  assert.ok(stable.formalProjectSnapshotSealReceiptHash);
});

test('Lake replay rejects every project and authority identity divergence before promotion', async (t) => {
  const root = temporaryLakeProject(t);
  const stableRunner = { run: async () => trustedExecution({ identitySuffix: 'replay-matrix' }) };
  const verifier = createLakeFormalVerifier({
    projectRoot: root,
    commandRunner: stableRunner,
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
  });
  const certificate = await verifier.verify();
  assert.equal(certificate.status, 'formal_build_verified');

  assert.deepEqual((await verifier.replay()).blockers, ['certificate_bundle_not_verified']);
  assert.deepEqual((await verifier.replay({ certificateBundle: { status: 'formal_certificate_blocked' } })).blockers,
    ['certificate_bundle_not_verified']);

  const invalidManifest = resignFormalCertificate(certificate, (payload) => ({
    ...payload,
    projectManifestHash: 'sha256:forged-manifest',
  }));
  assert.deepEqual((await verifier.replay({ certificateBundle: invalidManifest })).blockers,
    ['formal_certificate_project_manifest_invalid']);
  const missingProjectFileList = resignFormalCertificate(certificate, (payload) => ({
    ...payload,
    projectFiles: null,
    projectManifestHash: formalProjectManifestHash([]),
  }));
  assert.ok((await verifier.replay({ certificateBundle: missingProjectFileList })).blockers
    .some((blocker) => blocker.startsWith('formal_project_unlisted_input:')));
  const omittedClaimBindings = resignFormalCertificate(certificate, (payload) => ({
    ...payload,
    claimBindings: null,
  }));
  assert.equal((await verifier.replay({ certificateBundle: omittedClaimBindings })).status,
    'formal_build_replay_verified');

  const mainPath = path.join(root, 'Main.lean');
  const mainContent = fs.readFileSync(mainPath);
  const mainMode = fs.statSync(mainPath).mode & 0o777;
  fs.rmSync(mainPath);
  const missing = await verifier.replay({ certificateBundle: certificate });
  assert.ok(missing.blockers.includes('formal_input_missing:Main.lean'));
  fs.writeFileSync(mainPath, mainContent, { mode: mainMode });

  fs.writeFileSync(mainPath, `${mainContent.toString('utf8')}\n-- changed\n`);
  const changed = await verifier.replay({ certificateBundle: certificate });
  assert.ok(changed.blockers.includes('formal_input_hash_mismatch:Main.lean'));
  fs.writeFileSync(mainPath, mainContent);
  fs.chmodSync(mainPath, mainMode ^ 0o100);
  const modeChanged = await verifier.replay({ certificateBundle: certificate });
  assert.ok(modeChanged.blockers.includes('formal_input_mode_mismatch:Main.lean'));
  fs.chmodSync(mainPath, mainMode);

  const fallbackProjectFiles = certificate.projectFiles.map((file) => (
    file.path === 'Main.lean'
      ? (() => {
        const { sourcePath: _sourcePath, projectPath: _projectPath, role: _role, ...fallback } = file;
        return fallback;
      })()
      : file
  ));
  const fallbackMetadata = resignFormalCertificate(certificate, (payload) => ({
    ...payload,
    projectFiles: fallbackProjectFiles,
    projectManifestHash: formalProjectManifestHash(fallbackProjectFiles),
  }));
  assert.equal((await verifier.replay({ certificateBundle: fallbackMetadata })).status,
    'formal_build_replay_verified');

  const mismatchedMetadataFiles = certificate.projectFiles.map((file) => (
    file.path === 'Main.lean' ? { ...file, sourcePath: 'Other.lean' } : file
  ));
  const mismatchedMetadata = resignFormalCertificate(certificate, (payload) => ({
    ...payload,
    projectFiles: mismatchedMetadataFiles,
    projectManifestHash: formalProjectManifestHash(mismatchedMetadataFiles),
  }));
  assert.ok((await verifier.replay({ certificateBundle: mismatchedMetadata })).blockers
    .includes('formal_input_hash_mismatch:Main.lean'));

  const identityMutations = [
    (payload) => ({ ...payload, toolchainHash: 'sha256:forged-toolchain-file' }),
    (payload) => ({
      ...payload,
      toolchainRuntimeIdentity: {
        ...payload.toolchainRuntimeIdentity,
        leanToolchainContentIdentityHash: 'sha256:forged-runtime-toolchain',
      },
    }),
    (payload) => ({ ...payload, systemAuditHash: 'sha256:forged-system-audit' }),
    (payload) => ({ ...payload, auditTargets: ['Injected.lean'] }),
    (payload) => ({ ...payload, formalAuditInvocationHash: 'sha256:forged-invocation' }),
    (payload) => {
      const projectFiles = [...payload.projectFiles].reverse();
      return { ...payload, projectFiles, projectManifestHash: formalProjectManifestHash(projectFiles) };
    },
    (payload) => ({ ...payload, formalProjectClosureHash: 'sha256:forged-closure' }),
    (payload) => ({
      ...payload,
      claimBindingReport: { formalClaimBindingHash: 'sha256:forged-binding-report' },
    }),
  ];
  for (const mutation of identityMutations) {
    const forged = resignFormalCertificate(certificate, mutation);
    const replay = await verifier.replay({ certificateBundle: forged });
    assert.ok(replay.blockers.includes('formal_replay_authority_identity_mismatch'), JSON.stringify(replay));
  }

  const statusMismatch = resignFormalCertificate(certificate, (payload) => ({
    ...payload,
    status: 'formal_claim_verified',
  }));
  const mismatchedRerun = await verifier.replay({ certificateBundle: statusMismatch });
  assert.ok(mismatchedRerun.blockers.includes('formal_project_reexecution_mismatch'));

  fs.symlinkSync('Main.lean', path.join(root, 'ForbiddenLink.lean'));
  const unsafeClosure = await verifier.replay({ certificateBundle: certificate });
  assert.ok(unsafeClosure.blockers.includes('formal_project_symlink_forbidden:ForbiddenLink.lean'));
  fs.rmSync(path.join(root, 'ForbiddenLink.lean'));

  const dynamicSource = [
    'import Init',
    'theorem dynamicReplay : ∀ n : Nat, n = n := by intro n; rfl',
    '',
  ].join('\n');
  fs.writeFileSync(mainPath, dynamicSource);
  const dynamicDeclaration = leanSourceDeclarationRecords(dynamicSource)[0];
  const dynamicBinding = dynamicFormalBinding({
    declaration: dynamicDeclaration,
    claimId: 'claim-dynamic-replay',
  });
  const dynamicAudit = [
    'dynamicReplay : ∀ n : Nat, n = n',
    "'dynamicReplay' does not depend on any axioms",
  ].join('\n');
  const dynamicVerifier = createLakeFormalVerifier({
    projectRoot: root,
    commandRunner: {
      run: async () => trustedExecution({ stdout: dynamicAudit, identitySuffix: 'dynamic-replay' }),
    },
    toolchainIdentityProvider: fixtureToolchainIdentityProvider,
  });
  const dynamicCertificate = await dynamicVerifier.verify({ claimBindings: [dynamicBinding] });
  assert.equal(dynamicCertificate.status, 'formal_claim_verified');
  const dynamicReplay = await dynamicVerifier.replay({ certificateBundle: dynamicCertificate });
  assert.equal(dynamicReplay.status, 'formal_claim_replay_verified', JSON.stringify(dynamicReplay, null, 2));
});
