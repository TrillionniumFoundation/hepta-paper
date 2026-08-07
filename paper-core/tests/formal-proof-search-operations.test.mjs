import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFormalProofSearchOperationsExecutor,
  buildPinnedMathlibSymbolSearchReceipt,
  FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO,
  verifyPinnedMathlibSymbolSearchReceipt,
  verifyFormalProofSearchOperationReceipt,
} from '../../paper-adapters/research-verify/formal-proof-search-operations-executor.mjs';
import {
  createFormalProofSearchPlan,
  createTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import {
  buildFormalProofStrategyPreparation,
} from '../../paper-domain/research/formal-proof-strategy-registry.mjs';
import {
  PRODUCTION_LEAN_RUNTIME_LAYOUTS,
  PRODUCTION_LEAN_TOOLCHAIN,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import {
  buildTypedTheoremDslFromLeanType,
  searchTypedTheoremDslCounterexample,
} from '../../paper-domain/research/typed-theorem-dsl.mjs';
import { leanTypeIdentity } from '../../paper-domain/research/lean-type-identity.mjs';
import { createTheoremSpecification } from '../../paper-domain/research/theorem-specification.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  trustedProductionLakeOrSkip,
} from './support/trusted-production-lake-preflight.mjs';

const digest = (label) => hashRecord('FormalProofSearchOperationsFixture', { label });
const PRODUCTION_LAKE_EXECUTABLE_HASH =
  PRODUCTION_LEAN_RUNTIME_LAYOUTS[PRODUCTION_LEAN_TOOLCHAIN].lakeExecutableHash;

function fixturePinnedRuntime() {
  return Object.freeze({
    status: 'formal_pinned_lake_resolved',
    executable: '/fixture/pinned/lake',
    lakeExecutable: '/fixture/pinned/lake',
    lakeExecutableHash: PRODUCTION_LAKE_EXECUTABLE_HASH,
    blockers: Object.freeze([]),
  });
}

function dynamicSpecification(leanTypeSource, { allowedImports = ['Init'] } = {}) {
  const statement = `Authorized formal claim for ${leanTypeSource}.`;
  const authorityBindingHash = digest(`binding:${leanTypeSource}`);
  const authorityBundleHash = digest(`bundle:${leanTypeSource}`);
  const leanNormalizedTypeHash = leanTypeIdentity(leanTypeSource).normalizedTypeHash;
  const assumptions = ['Only the declared typed domain is in scope.'];
  const quantifiers = ['Only the exact Lean binders are quantified.'];
  const negativeBoundaries = ['No empirical or causal conclusion follows.'];
  const proofObligations = ['Close the exact generated Lean proposition without axioms.'];
  return createTheoremSpecification({
    paperId: 'formal-search-paper',
    campaignId: 'formal-search-campaign',
    sourceManuscriptPath: 'main.tex',
    sourceManuscriptHash: digest('manuscript'),
    formalClaimUniverseHash: digest('universe'),
    claimAuthorityType: 'machine-policy-authorized',
    claimAuthorityBindingHash: authorityBindingHash,
    claimAuthorityBundleHash: authorityBundleHash,
    claims: [{
      claimKey: 'dynamic-formal-search',
      title: 'Dynamic formal search claim',
      statement,
      assumptions,
      quantifiers,
      negativeBoundaries,
      proofObligations,
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      manuscriptSource: {
        path: 'main.tex', byteStart: 0, byteEnd: 1,
        contentHash: digest('manuscript'),
        formalClaimUniverseEntryHash: digest('universe-entry'),
      },
      proposalClaimSource: {
        claimAuthorityType: 'machine-policy-authorized',
        claimAuthorityBindingHash: authorityBindingHash,
        claimAuthorityBundleHash: authorityBundleHash,
        proposalClaimId: 'dynamic-formal-search-claim',
        proposalClaimText: statement,
        scientificClaimKey: 'dynamic-formal-search',
        assumptions,
        quantifiers,
        negativeBoundaries,
        proofObligations,
        proposalClaimTextHash: hashBytes(Buffer.from(statement, 'utf8')),
        proposalClaimRecordHash: digest(`proposal:${leanTypeSource}`),
        proposalSeedContractBundleHash: null,
        approvedProposalSeedBindingHash: null,
        dynamicFormalClaimSeedHash: digest(`seed:${leanTypeSource}`),
        leanDeclarationName: 'generatedFormalSearchClaim',
        leanTypeSource,
        leanTypeSourceHash: hashBytes(Buffer.from(leanTypeSource, 'utf8')),
        leanNormalizedTypeHash,
        allowedImports,
        formalClaimCapabilityScopeManifestHash: digest('scope'),
        formalClaimGeneratorReceiptHash: digest('generator'),
      },
    }],
  });
}

function authority(leanTypeSource, options) {
  const theoremSpecification = dynamicSpecification(leanTypeSource, options);
  const bundle = createTypedTheoremObligationBundle(theoremSpecification);
  const plan = createFormalProofSearchPlan(bundle);
  return { theoremSpecification, bundle, plan };
}

function rehashOperationReceipt(receipt) {
  const clone = structuredClone(receipt);
  delete clone.formalProofSearchOperationReceiptHash;
  return Object.freeze({
    ...clone,
    formalProofSearchOperationReceiptHash:
      hashRecord('FormalProofSearchOperationReceipt', clone),
  });
}

function absentDockerRecoveryReceipt(label) {
  const payload = {
    version: 1,
    kind: 'DockerWorkerContainerRecoveryReceipt',
    trigger: 'launcher_signal:SIGPIPE',
    containerName: `hepta-os-worker-${label.padEnd(32, '0').slice(0, 32)}`,
    processInvocationId: digest(`recovery-process:${label}`),
    dockerWorkerContainerOwnershipHash: digest(`recovery-ownership:${label}`),
    status: 'docker_worker_container_recovery_absent',
    containerId: null,
    inspectionAttemptCount: 5,
    removalAttemptCount: 0,
    removalConfirmed: true,
    externalActionPerformed: false,
    blockers: [],
  };
  return {
    ...payload,
    dockerWorkerContainerRecoveryReceiptHash:
      hashRecord('DockerWorkerContainerRecoveryReceipt', payload),
  };
}

test('typed theorem DSL deterministically binds Lean type and rejects unsupported domains', () => {
  const compiled = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ n : Nat, 0 + n = n',
    allowedImports: ['Init'],
  });
  assert.equal(compiled.status, 'typed_theorem_dsl_compiled');
  assert.equal(compiled.compiledLeanTypeSource, '∀ n : Nat, 0 + n = n');
  assert.equal(compiled.compiledLeanNormalizedTypeHash,
    compiled.sourceLeanNormalizedTypeHash);
  assert.deepEqual(compiled.negativeScope.excludedClaimClasses, [
    'causal_inference', 'empirical_generalization', 'open_world_domain_extension',
  ]);

  const unsupported = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ α : Type, α = α',
    allowedImports: ['Init'],
  });
  assert.equal(unsupported.status, 'typed_theorem_dsl_semantic_review_only');
  assert.equal(unsupported.machineSearchEligible, false);
  assert.match(unsupported.semanticReviewOnlyReason, /domain_unsupported/);
});

test('typed theorem DSL compiles Real polynomial obligations and searches only an incomplete integer embedding', () => {
  const source = '∀ x y z : Real, x * (y + z) = x * y + x * z';
  const compiled = buildTypedTheoremDslFromLeanType({
    leanTypeSource: source,
    allowedImports: ['Mathlib'],
  });
  assert.equal(compiled.status, 'typed_theorem_dsl_compiled');
  assert.equal(compiled.machineSearchEligible, true);
  assert.deepEqual(compiled.binders.map((binder) => binder.domain), [
    { kind: 'real' }, { kind: 'real' }, { kind: 'real' },
  ]);
  assert.equal(compiled.compiledLeanTypeSource, source);
  const missingMathlib = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ x : Real, x = x',
    allowedImports: ['Init'],
  });
  assert.equal(missingMathlib.status, 'typed_theorem_dsl_semantic_review_only');
  assert.equal(missingMathlib.semanticReviewOnlyReason,
    'typed_theorem_dsl_real_mathlib_import_required');

  const search = searchTypedTheoremDslCounterexample(compiled, {
    realAbsoluteBound: 2,
    maximumAssignments: 125,
  });
  assert.equal(search.status, 'bounded_counterexample_search_inconclusive');
  assert.equal(search.reason, 'bounded_prefix_exhausted');
  assert.equal(search.completeFiniteDomain, false);
  assert.equal(search.checkedAssignments, 125);
  assert.equal(search.witness, null);

  const falseClaim = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ x : Real, x * x = x',
    allowedImports: ['Mathlib'],
  });
  const refutation = searchTypedTheoremDslCounterexample(falseClaim, {
    realAbsoluteBound: 2,
  });
  assert.equal(refutation.status, 'bounded_counterexample_found');
  assert.deepEqual(refutation.witness, { x: -2 });
});

test('bounded counterexample search returns a witness and never treats bounded absence as truth', () => {
  const falseFinite = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ n : Fin 4, n = 3', allowedImports: ['Init'],
  });
  const witness = searchTypedTheoremDslCounterexample(falseFinite);
  assert.equal(witness.status, 'bounded_counterexample_found');
  assert.deepEqual(witness.witness, { n: 0 });
  assert.equal(witness.completeFiniteDomain, true);

  const infinite = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ n : Nat, n = n', allowedImports: ['Init'],
  });
  const inconclusive = searchTypedTheoremDslCounterexample(infinite);
  assert.equal(inconclusive.status, 'bounded_counterexample_search_inconclusive');
  assert.equal(inconclusive.reason, 'bounded_prefix_exhausted');
});

test('pinned local Mathlib search binds query, source index, results, and source tamper', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-mathlib-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, '.lake', 'packages', 'mathlib', 'Mathlib');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  const sourcePath = path.join(sourceDirectory, 'Fixture.lean');
  fs.writeFileSync(sourcePath, [
    'theorem nat_add_fixture (n : Nat) : 0 + n = n := by simp',
    'lemma bool_identity_fixture (b : Bool) : b = b := rfl',
    '',
  ].join('\n'));
  const dsl = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ n : Nat, 0 + n = n', allowedImports: ['Mathlib'],
  });
  const receipt = buildPinnedMathlibSymbolSearchReceipt({ root, dsl });
  assert.equal(receipt.status, 'pinned_mathlib_symbol_search_completed');
  assert.equal(receipt.indexFileCount, 1);
  assert.equal(receipt.networkAccessAllowed, false);
  assert.ok(receipt.results.some((entry) => entry.name === 'nat_add_fixture'));
  assert.equal(verifyPinnedMathlibSymbolSearchReceipt(receipt, { dsl }), true);
  const preparation = buildFormalProofStrategyPreparation({
    strategy: 'mathlib_retrieval',
    dsl,
    mathlibSymbolSearchReceipt: receipt,
  });
  assert.equal(
    preparation.lemmaRetrieval.status,
    'formal_proof_pinned_lemma_retrieval_ready',
  );
  assert.ok(preparation.lemmaRetrieval.retrievedDeclarationNames
    .includes('nat_add_fixture'));
  assert.equal(preparation.lemmaRetrieval.automaticDeclarationInjectionAllowed, false);
  const wrongDsl = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ b : Bool, b = b', allowedImports: ['Mathlib'],
  });
  assert.equal(verifyPinnedMathlibSymbolSearchReceipt(receipt, { dsl: wrongDsl }), false);
  const wrongIndex = structuredClone(receipt);
  wrongIndex.indexManifest[0].hash = digest('wrong-index-source');
  delete wrongIndex.pinnedMathlibSymbolSearchReceiptHash;
  wrongIndex.pinnedMathlibSymbolSearchReceiptHash =
    hashRecord('PinnedMathlibSymbolSearchReceipt', wrongIndex);
  assert.equal(verifyPinnedMathlibSymbolSearchReceipt(wrongIndex, { dsl }), false);
  fs.appendFileSync(sourcePath, 'lemma altered_index : True := by trivial\n');
  const changed = buildPinnedMathlibSymbolSearchReceipt({ root, dsl });
  assert.notEqual(changed.indexManifestHash, receipt.indexManifestHash);
  assert.notEqual(changed.pinnedMathlibSymbolSearchReceiptHash,
    receipt.pinnedMathlibSymbolSearchReceiptHash);
});

test('real pinned Lean proof-state search closes and replays with separate process receipts', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const preflight = trustedProductionLakeOrSkip(t);
  if (!preflight) return;
  const { theoremSpecification, bundle, plan } = authority('∀ n : Nat, n = n');
  const receipt = await createFormalProofSearchOperationsExecutor({
    trustedSandboxRuntime: preflight.formalSandboxRuntime,
    timeoutMs: 90_000,
  }).execute({
    theoremSpecification,
    bundle,
    plan,
    candidate: plan.candidates[0],
  });
  assert.equal(receipt.status, 'formal_proof_search_operations_verified',
    JSON.stringify(receipt, null, 2));
  assert.equal(receipt.selectedTactic, 'rfl');
  assert.equal(receipt.replayMatched, true);
  assert.equal(
    receipt.formalProofStrategyPreparation.goalDecomposition.status,
    'formal_proof_syntactic_goal_decomposition_ready',
  );
  assert.deepEqual(
    receipt.formalProofStrategyPreparation.goalDecomposition.introductionNames,
    ['n'],
  );
  assert.equal(
    receipt.formalProofStrategyPreparation.semanticBoundary
      .naturalLanguageToFormalEquivalenceEstablished,
    false,
  );
  assert.notEqual(
    receipt.operationReceipts[0].executionProcessIdentityHash,
    receipt.replayExecutionReceipt.executionProcessIdentityHash,
  );
  assert.equal(verifyFormalProofSearchOperationReceipt(receipt, {
    bundle, plan, candidate: plan.candidates[0],
  }).valid, true);

  const tacticTamper = structuredClone(receipt);
  tacticTamper.operationReceipts[0].stdoutHash = digest('forged-output');
  const tacticTamperedReceipt = rehashOperationReceipt(tacticTamper);
  assert.equal(verifyFormalProofSearchOperationReceipt(tacticTamperedReceipt, {
    bundle, plan, candidate: plan.candidates[0],
  }).valid, false);

  const falseStrategy = structuredClone(receipt);
  falseStrategy.selectedTactic = 'admit';
  const falseStrategyReceipt = rehashOperationReceipt(falseStrategy);
  assert.ok(verifyFormalProofSearchOperationReceipt(falseStrategyReceipt, {
    bundle, plan, candidate: plan.candidates[0],
  }).blockers.includes('formal_proof_search_selected_tactic_invalid'));
});

test('pinned proof-state search advances beyond reflexivity and replays simp closure', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const preflight = trustedProductionLakeOrSkip(t);
  if (!preflight) return;
  const { theoremSpecification, bundle, plan } = authority('∀ n : Nat, n + 0 = n');
  const candidate = plan.candidates.find((item) => item.strategy === 'mathlib_retrieval');
  const receipt = await createFormalProofSearchOperationsExecutor({
    trustedSandboxRuntime: preflight.formalSandboxRuntime,
    timeoutMs: 90_000,
  }).execute({ theoremSpecification, bundle, plan, candidate });
  assert.equal(receipt.status, 'formal_proof_search_operations_verified',
    JSON.stringify(receipt, null, 2));
  assert.equal(receipt.selectedTactic, 'simp');
  assert.equal(receipt.replayMatched, true);
  assert.equal(
    receipt.formalProofStrategyPreparation.lemmaRetrieval.status,
    'formal_proof_lemma_retrieval_not_requested',
  );
  assert.equal(verifyFormalProofSearchOperationReceipt(receipt, {
    bundle, plan, candidate,
  }).valid, true);
});

test('Mathlib tactic portfolio includes bounded vector extensionality closure', () => {
  assert.deepEqual(FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO.mathlib_retrieval, [
    'simp', 'simpa', 'ext i <;> simp', 'aesop',
  ]);
});

test('counterexample candidate terminates with a hash-bound refutation witness before Lean synthesis', async () => {
  const { theoremSpecification, bundle, plan } = authority('∀ n : Fin 4, n = 3');
  const receipt = await createFormalProofSearchOperationsExecutor().execute({
    theoremSpecification,
    bundle,
    plan,
    candidate: plan.candidates[2],
  });
  assert.equal(receipt.status, 'formal_proof_search_counterexample_found');
  assert.deepEqual(receipt.counterexampleSearchReceipts[0].witness, { n: 0 });
  assert.deepEqual(receipt.operationReceipts, []);
  assert.equal(
    receipt.formalProofStrategyPreparation.counterexampleGuidedRepair.status,
    'formal_proof_counterexample_guided_repair_proposed',
  );
  assert.equal(
    receipt.formalProofStrategyPreparation.counterexampleGuidedRepair.claimMutationAllowed,
    false,
  );
  assert.equal(verifyFormalProofSearchOperationReceipt(receipt, {
    bundle, plan, candidate: plan.candidates[2],
  }).valid, true);
});

test('timeout and runner crash cannot be presented as an executed proof-search strategy', async () => {
  const { theoremSpecification, bundle, plan } = authority('∀ n : Nat, n = n');
  const timeoutExecutor = createFormalProofSearchOperationsExecutor({
    resolvePinnedRuntime: fixturePinnedRuntime,
    workerRunnerFactory: () => ({
      async run() {
        return {
          ok: false, exitCode: null, signal: 'SIGKILL', stdout: '', stderr: 'timeout',
          blockers: ['os_sandbox_command_timed_out'], receiptHash: digest('timeout-receipt'),
          executionProcessIdentityHash: digest('timeout-process'),
          runnerId: 'fixture-runner', backend: 'fixture', runtimeIdentityType: 'fixture',
          runtimeIdentityHash: digest('timeout-runtime'),
          runtimeExecutableSnapshotHash: digest('timeout-executable'),
          containerImageDigest: digest('timeout-image'),
        };
      },
    }),
  });
  const timedOut = await timeoutExecutor.execute({
    theoremSpecification, bundle, plan, candidate: plan.candidates[0],
  });
  assert.equal(timedOut.status, 'formal_proof_search_operations_blocked');
  assert.equal(timedOut.operationReceipts[0].status,
    'formal_proof_state_tactic_timed_out');
  assert.equal(verifyFormalProofSearchOperationReceipt(timedOut, {
    bundle, plan, candidate: plan.candidates[0],
  }).valid, false);

  const crashExecutor = createFormalProofSearchOperationsExecutor({
    resolvePinnedRuntime: fixturePinnedRuntime,
    workerRunnerFactory: () => ({ async run() { throw new Error('fixture-runner-crash'); } }),
  });
  await assert.rejects(() => crashExecutor.execute({
    theoremSpecification, bundle, plan, candidate: plan.candidates[0],
  }), /fixture-runner-crash/);
});

test('Docker SIGPIPE is retried once with hash-bound infrastructure failure evidence', async () => {
  const { theoremSpecification, bundle, plan } = authority('∀ n : Nat, n = n');
  let calls = 0;
  const runtimeIdentityHash = digest('sigpipe-runtime');
  const runtimeExecutableSnapshotHash = PRODUCTION_LAKE_EXECUTABLE_HASH;
  const containerImageDigest = digest('sigpipe-image');
  const executor = createFormalProofSearchOperationsExecutor({
    resolvePinnedRuntime: fixturePinnedRuntime,
    workerRunnerFactory: () => ({
      async run() {
        calls += 1;
        const common = {
          runnerId: 'fixture-runner',
          backend: 'docker',
          runtimeIdentityType: 'container',
          runtimeIdentityHash,
          runtimeExecutableSnapshotHash,
          containerImageDigest,
          stdout: 'proof-state-closed',
          stderr: '',
          isolation: { immutableWorkRootVerified: false },
        };
        if (calls === 1) {
          return {
            ...common,
            ok: false,
            exitCode: null,
            signal: 'SIGPIPE',
            stdout: '',
            stderr: 'docker transport pipe closed',
            receiptHash: digest('sigpipe-receipt'),
            executionProcessIdentityHash: digest('sigpipe-process'),
            dockerWorkerContainerRecoveryReceipt:
              absentDockerRecoveryReceipt('sigpipe'),
          };
        }
        return {
          ...common,
          ok: true,
          exitCode: 0,
          signal: null,
          receiptHash: digest(`success-receipt:${calls}`),
          executionProcessIdentityHash: digest(`success-process:${calls}`),
        };
      },
    }),
  });
  const receipt = await executor.execute({
    theoremSpecification, bundle, plan, candidate: plan.candidates[0],
  });
  assert.equal(calls, 3);
  assert.equal(receipt.status, 'formal_proof_search_operations_verified');
  assert.equal(receipt.operationReceipts[0].infrastructureRetryCount, 1);
  assert.equal(
    receipt.operationReceipts[0].infrastructureFailureReceipts[0].signal,
    'SIGPIPE',
  );
  assert.equal(receipt.replayExecutionReceipt.infrastructureRetryCount, 0);
  assert.equal(verifyFormalProofSearchOperationReceipt(receipt, {
    bundle, plan, candidate: plan.candidates[0],
  }).valid, true);

  const tampered = structuredClone(receipt);
  tampered.operationReceipts[0]
    .infrastructureFailureReceipts[0].signal = 'SIGKILL';
  const rehashed = rehashOperationReceipt(tampered);
  assert.equal(verifyFormalProofSearchOperationReceipt(rehashed, {
    bundle, plan, candidate: plan.candidates[0],
  }).valid, false);
});

test('candidate authority mismatch is rejected even after rehashing an operation receipt', async () => {
  const { theoremSpecification, bundle, plan } = authority('∀ n : Nat, n = n');
  const semantic = createFormalProofSearchOperationsExecutor({
    workerRunnerFactory: () => ({ async run() { throw new Error('not-called'); } }),
  });
  const unsupportedSpecification = dynamicSpecification('∀ α : Type, α = α');
  const unsupportedBundle = createTypedTheoremObligationBundle(unsupportedSpecification);
  const unsupportedPlan = createFormalProofSearchPlan(unsupportedBundle);
  const receipt = await semantic.execute({
    theoremSpecification: unsupportedSpecification,
    bundle: unsupportedBundle,
    plan: unsupportedPlan,
    candidate: unsupportedPlan.candidates[0],
  });
  assert.equal(receipt.status, 'formal_proof_search_operations_semantic_review_only');
  assert.equal(receipt.formalProofStrategyPreparation, null);
  assert.equal(verifyFormalProofSearchOperationReceipt(receipt, {
    bundle: unsupportedBundle,
    plan: unsupportedPlan,
    candidate: unsupportedPlan.candidates[0],
    allowSemanticReviewOnly: true,
  }).valid, true);
  assert.equal(verifyFormalProofSearchOperationReceipt(receipt, {
    bundle, plan, candidate: plan.candidates[0], allowSemanticReviewOnly: true,
  }).valid, false);
  assert.equal(theoremSpecification.kind, 'TheoremSpecification');
});
