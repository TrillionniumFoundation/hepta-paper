import os from 'node:os';

import {
  buildFormalProofStrategyPreparation,
  FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO,
  formalProofSearchTactics,
  verifyFormalProofStrategyPreparation,
} from '../../paper-domain/research/formal-proof-strategy-registry.mjs';
import { verifyFormalProofSearchPlan, verifyTypedTheoremObligationBundle } from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import { searchTypedTheoremDslCounterexample } from '../../paper-domain/research/typed-theorem-dsl.mjs';
import {
  PRODUCTION_LEAN_RUNTIME_LAYOUTS,
  PRODUCTION_LEAN_TOOLCHAIN,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';
import {
  verifyDockerWorkerContainerRecoveryReceipt,
} from '../runtime/docker-worker-container-recovery.mjs';
import {
  assertCurrentDynamicFormalExecutionAuthority,
  verifyDynamicFormalExecutionAuthority,
} from './dynamic-formal-project-closure-readiness.mjs';
import {
  createFormalProofSearchWorkspaceRepository,
  verifyFormalExecutionSnapshotReceipt,
} from './formal-proof-search-workspace-repository.mjs';
import {
  buildPinnedMathlibSymbolSearchReceipt,
  verifyPinnedMathlibSymbolSearchReceipt,
} from './formal-lemma-retrieval-index.mjs';
import { resolvePinnedLakeExecutable } from './pinned-lake-executable-resolver.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_INFRASTRUCTURE_RETRIES = 1;
const PRODUCTION_LAKE_EXECUTABLE_HASH =
  PRODUCTION_LEAN_RUNTIME_LAYOUTS[PRODUCTION_LEAN_TOOLCHAIN].lakeExecutableHash;
export {
  buildPinnedMathlibSymbolSearchReceipt,
  FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO,
  verifyPinnedMathlibSymbolSearchReceipt,
};

function tacticSources(strategy) {
  return formalProofSearchTactics(strategy);
}

function proofSearchSource({ imports, leanTypeSource, dsl, tactic }) {
  const introductionNames = [
    ...dsl.binders.map((binder) => binder.name),
    ...dsl.assumptions.map((_, index) => `heptaAssumption${index + 1}`),
  ];
  return [
    ...imports.map((moduleName) => `import ${moduleName}`),
    '',
    `example : ${leanTypeSource} := by`,
    '  trace_state',
    ...(introductionNames.length ? [`  intro ${introductionNames.join(' ')}`] : []),
    `  ${tactic}`,
    '  all_goals trace_state',
    '',
  ].join('\n');
}

function runtimeIdentity(execution) {
  return Object.freeze({
    runnerId: execution?.runnerId || null,
    backend: execution?.backend || null,
    runtimeIdentityType: execution?.runtimeIdentityType || null,
    runtimeIdentityHash: execution?.runtimeIdentityHash || null,
    runtimeExecutableSnapshotHash: execution?.runtimeExecutableSnapshotHash || null,
    containerImageDigest: execution?.containerImageDigest || null,
  });
}

function executionReceipt({
  execution,
  source,
  tactic,
  goalBefore,
  infrastructureFailureReceipts = [],
}) {
  const stdout = String(execution?.stdout || '');
  const stderr = String(execution?.stderr || '');
  const payload = {
    version: 1,
    kind: 'FormalProofStateTacticExecutionReceipt',
    status: execution?.ok
      ? 'formal_proof_state_tactic_closed'
      : execution?.blockers?.includes('os_sandbox_command_timed_out')
        ? 'formal_proof_state_tactic_timed_out'
        : 'formal_proof_state_tactic_failed',
    tactic,
    sourceHash: hashBytes(Buffer.from(source, 'utf8')),
    goalBefore,
    goalBeforeHash: hashBytes(Buffer.from(goalBefore, 'utf8')),
    goalAfter: execution?.ok ? 'no_goals' : 'unresolved_or_elaboration_failed',
    exitCode: Number.isInteger(execution?.exitCode) ? execution.exitCode : null,
    signal: execution?.signal || null,
    stdoutHash: hashBytes(Buffer.from(stdout, 'utf8')),
    stderrHash: hashBytes(Buffer.from(stderr, 'utf8')),
    traceOutputHash: hashRecord('FormalProofStateTraceOutput', { stdout, stderr }),
    usedDeclarations: Object.freeze(tactic.match(/[A-Za-z_][A-Za-z0-9_'.]*/g) || []),
    executionReceiptHash: execution?.receiptHash || null,
    executionProcessIdentityHash: execution?.executionProcessIdentityHash || null,
    executionIdentity: runtimeIdentity(execution),
    immutableWorkRootVerified:
      execution?.isolation?.immutableWorkRootVerified === true,
    dockerWorkerContainerRecoveryReceipt:
      execution?.dockerWorkerContainerRecoveryReceipt || null,
    infrastructureRetryCount: infrastructureFailureReceipts.length,
    infrastructureFailureReceipts: Object.freeze([
      ...infrastructureFailureReceipts,
    ]),
    networkAccessAllowed: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    formalProofStateTacticExecutionReceiptHash:
      hashRecord('FormalProofStateTacticExecutionReceipt', payload),
  });
}

async function runTactic({
  runner,
  executable,
  projectRoot,
  projectScopeRoot,
  workspaceRepository,
  imports,
  dsl,
  tactic,
  timeoutMs,
  signal,
  executionEnvironment,
  requireImmutableWorkRoot,
}) {
  const { relative, source } = stageTacticSource({
    projectRoot,
    workspaceRepository,
    imports,
    dsl,
    tactic,
  });
  const infrastructureFailureReceipts = [];
  for (let attempt = 0; attempt <= MAXIMUM_INFRASTRUCTURE_RETRIES; attempt += 1) {
    const execution = await runner.run({
      executable,
      args: ['env', 'lean', relative],
      cwd: projectRoot,
      sourceRoot: projectScopeRoot,
      timeoutMs,
      outputPaths: [],
      env: {
        ELAN_HOME: executionEnvironment.ELAN_HOME
          || `${executionEnvironment.HOME || ''}/.elan`,
        ELAN_TOOLCHAIN: PRODUCTION_LEAN_TOOLCHAIN,
      },
      language: 'lean',
      determinismPolicy: 'deterministic-proof-search-v1',
      requireImmutableWorkRoot,
      signal,
    });
    const receipt = executionReceipt({
      execution,
      source,
      tactic,
      goalBefore: dsl.compiledLeanTypeSource,
      infrastructureFailureReceipts,
    });
    const retryable = receipt.status === 'formal_proof_state_tactic_failed'
      && receipt.exitCode === null
      && receipt.signal === 'SIGPIPE'
      && receipt.executionIdentity.backend === 'docker'
      && verifyDockerWorkerContainerRecoveryReceipt(
        receipt.dockerWorkerContainerRecoveryReceipt,
      )
      && receipt.dockerWorkerContainerRecoveryReceipt.trigger === 'launcher_signal:SIGPIPE'
      && receipt.dockerWorkerContainerRecoveryReceipt.removalConfirmed === true;
    if (!retryable || attempt === MAXIMUM_INFRASTRUCTURE_RETRIES) return receipt;
    infrastructureFailureReceipts.push(receipt);
  }
  throw new Error('formal_proof_search_infrastructure_retry_exhausted');
}

function stageTacticSource({ projectRoot, workspaceRepository, imports, dsl, tactic }) {
  const relative = `HeptaProofSearch-${hashBytes(Buffer.from(tactic)).slice(7, 19)}.lean`;
  const source = proofSearchSource({
    imports,
    leanTypeSource: dsl.compiledLeanTypeSource,
    dsl,
    tactic,
  });
  workspaceRepository.stageLeanSource({ projectRoot, relative, source });
  return Object.freeze({ relative, source });
}

function replayMatches(original, replay) {
  return original.status === replay.status
    && original.sourceHash === replay.sourceHash
    && original.goalBeforeHash === replay.goalBeforeHash
    && original.goalAfter === replay.goalAfter
    && original.exitCode === replay.exitCode
    && original.stdoutHash === replay.stdoutHash
    && original.stderrHash === replay.stderrHash
    && original.traceOutputHash === replay.traceOutputHash
    && JSON.stringify(original.executionIdentity) === JSON.stringify(replay.executionIdentity);
}

function verifyInfrastructureRetryLineage(receipt) {
  const failures = Array.isArray(receipt?.infrastructureFailureReceipts)
    ? receipt.infrastructureFailureReceipts : [];
  const retryCount = receipt?.infrastructureRetryCount ?? 0;
  if (retryCount !== failures.length
    || failures.length > MAXIMUM_INFRASTRUCTURE_RETRIES) return false;
  return failures.every((failure) => (
    failure?.status === 'formal_proof_state_tactic_failed'
    && failure?.exitCode === null
    && failure?.signal === 'SIGPIPE'
    && failure?.executionIdentity?.backend === 'docker'
    && failure?.tactic === receipt?.tactic
    && failure?.sourceHash === receipt?.sourceHash
    && failure?.goalBeforeHash === receipt?.goalBeforeHash
    && verifyDockerWorkerContainerRecoveryReceipt(
      failure?.dockerWorkerContainerRecoveryReceipt,
    )
    && failure.dockerWorkerContainerRecoveryReceipt.trigger === 'launcher_signal:SIGPIPE'
    && failure.dockerWorkerContainerRecoveryReceipt.removalConfirmed === true
    && failure?.infrastructureRetryCount === 0
    && Array.isArray(failure?.infrastructureFailureReceipts)
    && failure.infrastructureFailureReceipts.length === 0
    && JSON.stringify(failure?.executionIdentity)
      === JSON.stringify(receipt?.executionIdentity)
    && failure?.executionProcessIdentityHash
      !== receipt?.executionProcessIdentityHash
  ));
}

function tacticReceiptHashValid(receipt) {
  const { formalProofStateTacticExecutionReceiptHash, ...payload } = receipt || {};
  return hashRecord('FormalProofStateTacticExecutionReceipt', payload)
    === formalProofStateTacticExecutionReceiptHash;
}

function semanticReviewOnlyReceipt({ bundle, plan, candidate }) {
  const payload = {
    version: 2,
    kind: 'FormalProofSearchOperationReceipt',
    status: 'formal_proof_search_operations_semantic_review_only',
    typedTheoremObligationBundleHash: bundle.typedTheoremObligationBundleHash,
    formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
    candidateId: candidate.candidateId,
    strategy: candidate.strategy,
    operationReceipts: Object.freeze([]),
    mathlibSymbolSearchReceipt: null,
    counterexampleSearchReceipts: Object.freeze([]),
    formalProofStrategyPreparation: null,
    selectedTactic: null,
    selectedTacticExecutionReceiptHash: null,
    replayExecutionReceiptHash: null,
    replayExecutionReceipt: null,
    replayMatched: false,
    machineSearchEstablished: false,
    semanticReviewOnly: true,
    dynamicFormalExecutionAuthority: null,
    initialFormalExecutionSnapshotReceipt: null,
    finalFormalExecutionSnapshotReceipt: null,
    blockers: Object.freeze(['typed_theorem_dsl_machine_search_not_available']),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    formalProofSearchOperationReceiptHash:
      hashRecord('FormalProofSearchOperationReceipt', payload),
  });
}

export function createFormalProofSearchOperationsExecutor({
  trustedSandboxRuntime = null,
  temporaryRoot = os.tmpdir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workerRunnerFactory = createOsSandboxedWorkerRunner,
  dynamicFormalExecutionAuthority = null,
  dynamicFormalExecutionEnvironment = process.env,
  dynamicFormalExecutionSpawnSync = undefined,
  resolvePinnedRuntime = resolvePinnedLakeExecutable,
} = {}) {
  const workspaceRepository = createFormalProofSearchWorkspaceRepository({
    temporaryRoot,
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
  });
  return Object.freeze({
    version: 2,
    kind: 'FormalProofSearchOperationsExecutor',
    async execute({ theoremSpecification, bundle, plan, candidate, workspace = null, signal = null } = {}) {
      if (!verifyTypedTheoremObligationBundle(bundle, { theoremSpecification }).valid
        || !verifyFormalProofSearchPlan(plan, { bundle }).valid
        || candidate !== plan.candidates?.[Number(candidate?.ordinal)]) {
        throw new Error('formal_proof_search_operation_authority_invalid');
      }
      const eligible = bundle.obligations.filter((obligation) => (
        obligation.typedTheoremDsl?.machineSearchEligible === true
      ));
      if (!eligible.length) return semanticReviewOnlyReceipt({ bundle, plan, candidate });
      if (eligible.length !== bundle.obligations.length || eligible.length !== 1) {
        throw new Error('formal_proof_search_mixed_or_multi_obligation_unsupported');
      }
      const obligation = eligible[0];
      const dsl = obligation.typedTheoremDsl;
      const imports = dsl.allowedImports.length ? dsl.allowedImports : ['Init'];
      const mathlibRequired = imports.some((moduleName) => (
        moduleName === 'Mathlib' || moduleName.startsWith('Mathlib.')
      ));
      const authorityOptions = {
        environment: dynamicFormalExecutionEnvironment,
        ...(dynamicFormalExecutionSpawnSync
          ? { spawnSyncImpl: dynamicFormalExecutionSpawnSync } : {}),
      };
      const activeAuthority = mathlibRequired
        ? assertCurrentDynamicFormalExecutionAuthority(
          dynamicFormalExecutionAuthority,
          authorityOptions,
        ).authority : null;
      if (activeAuthority && (!trustedSandboxRuntime
        || trustedSandboxRuntime.image !== activeAuthority.formalSandboxRuntimeImage
        || trustedSandboxRuntime.imageDigest
          !== activeAuthority.formalSandboxRuntimeImageDigest)) {
        throw new Error('dynamic_formal_execution_sandbox_authority_mismatch');
      }
      const project = await workspaceRepository.materialize({
        workspace: activeAuthority?.projectRoot || workspace,
        dependencyScopeRoot: activeAuthority?.projectScopeRoot
          || activeAuthority?.projectRoot || workspace,
        expectedFormalProjectClosureHash:
          activeAuthority?.formalProjectClosureHash || null,
        imports,
      });
      try {
        if (activeAuthority) {
          for (const tactic of tacticSources(candidate.strategy)) {
            stageTacticSource({
              projectRoot: project.root,
              workspaceRepository,
              imports,
              dsl,
              tactic,
            });
          }
          workspaceRepository.sealExecutionSnapshot({ projectRoot: project.root });
        }
        const initialFormalExecutionSnapshotReceipt =
          workspaceRepository.assertExecutionSnapshotCurrent({ projectRoot: project.root });
        const mathlibSymbolSearchReceipt = candidate.requiredOperations
          .includes('pinned_mathlib_symbol_search')
          ? buildPinnedMathlibSymbolSearchReceipt({ root: project.root, dsl }) : null;
        const counterexampleSearchReceipts = candidate.requiredOperations
          .includes('bounded_counterexample_search')
          ? Object.freeze([searchTypedTheoremDslCounterexample(dsl)]) : Object.freeze([]);
        const formalProofStrategyPreparation = buildFormalProofStrategyPreparation({
          strategy: candidate.strategy,
          dsl,
          mathlibSymbolSearchReceipt,
          counterexampleSearchReceipts,
        });
        if (counterexampleSearchReceipts.some((receipt) => (
          receipt.status === 'bounded_counterexample_found'
        ))) {
          const payload = {
            version: 2,
            kind: 'FormalProofSearchOperationReceipt',
            status: 'formal_proof_search_counterexample_found',
            typedTheoremObligationBundleHash: bundle.typedTheoremObligationBundleHash,
            formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
            candidateId: candidate.candidateId,
            strategy: candidate.strategy,
            operationReceipts: Object.freeze([]),
            mathlibSymbolSearchReceipt,
            counterexampleSearchReceipts,
            formalProofStrategyPreparation,
            selectedTactic: null,
            selectedTacticExecutionReceiptHash: null,
            replayExecutionReceiptHash: null,
            replayExecutionReceipt: null,
            replayMatched: false,
            machineSearchEstablished: true,
            semanticReviewOnly: false,
            dynamicFormalExecutionAuthority: activeAuthority,
            initialFormalExecutionSnapshotReceipt,
            finalFormalExecutionSnapshotReceipt: null,
            blockers: Object.freeze(['formal_proof_search_refuted_by_bounded_witness']),
            externalActionPerformed: false,
          };
          if (activeAuthority) {
            assertCurrentDynamicFormalExecutionAuthority(activeAuthority, authorityOptions);
          }
          const finalFormalExecutionSnapshotReceipt =
            workspaceRepository.assertExecutionSnapshotCurrent({ projectRoot: project.root });
          payload.finalFormalExecutionSnapshotReceipt = finalFormalExecutionSnapshotReceipt;
          return Object.freeze({ ...payload, formalProofSearchOperationReceiptHash: hashRecord('FormalProofSearchOperationReceipt', payload) });
        }
        const pinned = resolvePinnedRuntime({
          environment: dynamicFormalExecutionEnvironment,
        });
        if (pinned.status !== 'formal_pinned_lake_resolved') {
          throw new Error(`formal_proof_search_pinned_lake_unavailable:${pinned.blockers.join(',')}`);
        }
        const runner = workerRunnerFactory({
          allowedExecutables: [pinned.executable],
          expectedExecutableHashes: {
            [pinned.executable]: pinned.lakeExecutableHash,
          },
          allowedRoots: [project.scopeRoot],
          ...(trustedSandboxRuntime ? {
            dockerImage: trustedSandboxRuntime.image,
            allowedContainerImages: [trustedSandboxRuntime.image],
          } : {}),
          maximumTimeoutMs: timeoutMs,
          maximumCpuSeconds: Math.ceil(timeoutMs / 1000),
          maximumPids: 64,
          maximumCapturedBytes: 2 * 1024 * 1024,
        });
        const operationReceipts = [];
        let selected = null;
        for (const { tactic } of formalProofStrategyPreparation.proofTermSynthesis.candidates) {
          const receipt = await runTactic({
            runner, executable: pinned.executable, projectRoot: project.root,
            projectScopeRoot: project.scopeRoot,
            workspaceRepository, imports, dsl, tactic, timeoutMs, signal,
            executionEnvironment: dynamicFormalExecutionEnvironment,
            requireImmutableWorkRoot: Boolean(activeAuthority),
          });
          operationReceipts.push(receipt);
          if (receipt.status === 'formal_proof_state_tactic_closed') {
            selected = receipt;
            break;
          }
        }
        let replay = null;
        if (selected) {
          replay = await runTactic({
            runner, executable: pinned.executable, projectRoot: project.root,
            projectScopeRoot: project.scopeRoot,
            workspaceRepository, imports, dsl, tactic: selected.tactic, timeoutMs, signal,
            executionEnvironment: dynamicFormalExecutionEnvironment,
            requireImmutableWorkRoot: Boolean(activeAuthority),
          });
        }
        const matched = Boolean(selected && replay && replayMatches(selected, replay));
        const mathlibReady = !mathlibSymbolSearchReceipt
          || mathlibSymbolSearchReceipt.status === 'pinned_mathlib_symbol_search_completed';
        const blockers = [
          ...(!selected ? ['formal_proof_search_no_tactic_closed_goal'] : []),
          ...(!matched ? ['formal_proof_search_tactic_replay_mismatch'] : []),
          ...(!mathlibReady ? ['formal_proof_search_mathlib_index_unavailable'] : []),
        ];
        const payload = {
          version: 2,
          kind: 'FormalProofSearchOperationReceipt',
          status: blockers.length
            ? 'formal_proof_search_operations_blocked'
            : 'formal_proof_search_operations_verified',
          typedTheoremObligationBundleHash: bundle.typedTheoremObligationBundleHash,
          formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
          candidateId: candidate.candidateId,
          strategy: candidate.strategy,
          operationReceipts: Object.freeze(operationReceipts),
          mathlibSymbolSearchReceipt,
          counterexampleSearchReceipts,
          formalProofStrategyPreparation,
          selectedTactic: selected?.tactic || null,
          selectedTacticExecutionReceiptHash:
            selected?.formalProofStateTacticExecutionReceiptHash || null,
          replayExecutionReceiptHash:
            replay?.formalProofStateTacticExecutionReceiptHash || null,
          replayExecutionReceipt: replay,
          replayMatched: matched,
          machineSearchEstablished: blockers.length === 0,
          semanticReviewOnly: false,
          dynamicFormalExecutionAuthority: activeAuthority,
          initialFormalExecutionSnapshotReceipt,
          finalFormalExecutionSnapshotReceipt: null,
          blockers: Object.freeze(blockers),
          externalActionPerformed: false,
        };
        if (activeAuthority) {
          assertCurrentDynamicFormalExecutionAuthority(activeAuthority, authorityOptions);
        }
        payload.finalFormalExecutionSnapshotReceipt =
          workspaceRepository.assertExecutionSnapshotCurrent({ projectRoot: project.root });
        return Object.freeze({
          ...payload,
          formalProofSearchOperationReceiptHash:
            hashRecord('FormalProofSearchOperationReceipt', payload),
        });
      } finally {
        project.cleanup();
      }
    },
  });
}

export function verifyFormalProofSearchOperationReceipt(receipt, {
  bundle,
  plan,
  candidate,
  allowSemanticReviewOnly = false,
  expectedDynamicFormalExecutionAuthority = null,
} = {}) {
  const blockers = [];
  const { formalProofSearchOperationReceiptHash, ...payload } = receipt || {};
  if (hashRecord('FormalProofSearchOperationReceipt', payload)
    !== formalProofSearchOperationReceiptHash) blockers.push('formal_proof_search_operation_hash_invalid');
  if (receipt?.version !== 2) blockers.push('formal_proof_search_operation_version_invalid');
  if (receipt?.typedTheoremObligationBundleHash !== bundle?.typedTheoremObligationBundleHash
    || receipt?.formalProofSearchPlanHash !== plan?.formalProofSearchPlanHash
    || receipt?.candidateId !== candidate?.candidateId
    || receipt?.strategy !== candidate?.strategy) blockers.push('formal_proof_search_operation_authority_mismatch');
  if (receipt?.status === 'formal_proof_search_operations_semantic_review_only') {
    if (!allowSemanticReviewOnly || receipt.machineSearchEstablished !== false
      || receipt.semanticReviewOnly !== true
      || receipt.formalProofStrategyPreparation !== null) {
      blockers.push('formal_proof_search_semantic_only_not_allowed');
    }
  } else if (receipt?.status === 'formal_proof_search_counterexample_found') {
    if (!receipt.counterexampleSearchReceipts?.some((entry) => (
      entry?.status === 'bounded_counterexample_found' && entry?.witness
    ))) blockers.push('formal_proof_search_counterexample_receipt_invalid');
  } else if (receipt?.status !== 'formal_proof_search_operations_verified'
    || receipt.machineSearchEstablished !== true || receipt.semanticReviewOnly !== false
    || receipt.replayMatched !== true || !receipt.selectedTacticExecutionReceiptHash
    || !receipt.replayExecutionReceiptHash) {
    blockers.push('formal_proof_search_operations_not_verified');
  }
  const eligibleDsl = bundle?.obligations?.length === 1
    ? bundle.obligations[0]?.typedTheoremDsl : null;
  if (receipt?.status !== 'formal_proof_search_operations_semantic_review_only'
    && !verifyFormalProofStrategyPreparation(
      receipt?.formalProofStrategyPreparation,
      {
        strategy: candidate?.strategy,
        dsl: eligibleDsl,
        mathlibSymbolSearchReceipt: receipt?.mathlibSymbolSearchReceipt || null,
        counterexampleSearchReceipts: receipt?.counterexampleSearchReceipts || [],
      },
    )) {
    blockers.push('formal_proof_strategy_preparation_invalid');
  }
  const dynamicFormalRequired = eligibleDsl?.allowedImports?.some((moduleName) => (
    moduleName === 'Mathlib' || moduleName.startsWith('Mathlib.')
  )) === true;
  if (dynamicFormalRequired) {
    if (!verifyDynamicFormalExecutionAuthority(receipt?.dynamicFormalExecutionAuthority)) {
      blockers.push('formal_proof_search_dynamic_formal_authority_invalid');
    } else if (expectedDynamicFormalExecutionAuthority
      && JSON.stringify(receipt.dynamicFormalExecutionAuthority)
        !== JSON.stringify(expectedDynamicFormalExecutionAuthority)) {
      blockers.push('formal_proof_search_dynamic_formal_authority_mismatch');
    }
    const expectedImageDigest = receipt?.dynamicFormalExecutionAuthority
      ?.formalSandboxRuntimeImageDigest;
    if ((receipt?.operationReceipts || []).some((operation) => (
      operation?.executionIdentity?.containerImageDigest !== expectedImageDigest
      || operation?.immutableWorkRootVerified !== true
    )) || (receipt?.replayExecutionReceipt
      && (receipt.replayExecutionReceipt.executionIdentity?.containerImageDigest
        !== expectedImageDigest
        || receipt.replayExecutionReceipt.immutableWorkRootVerified !== true))) {
      blockers.push('formal_proof_search_dynamic_formal_sandbox_identity_mismatch');
    }
    if (!verifyFormalExecutionSnapshotReceipt(
      receipt?.initialFormalExecutionSnapshotReceipt,
      {
        formalProjectClosureHash:
          receipt.dynamicFormalExecutionAuthority.formalProjectClosureHash,
        formalProjectManifestHash:
          receipt.dynamicFormalExecutionAuthority.formalProjectManifestHash,
        requireNoStagedSources: false,
      },
    ) || !verifyFormalExecutionSnapshotReceipt(
      receipt?.finalFormalExecutionSnapshotReceipt,
      {
        formalProjectClosureHash:
          receipt.dynamicFormalExecutionAuthority.formalProjectClosureHash,
        formalProjectManifestHash:
          receipt.dynamicFormalExecutionAuthority.formalProjectManifestHash,
      },
    )) {
      blockers.push('formal_proof_search_execution_snapshot_receipt_invalid');
    }
  } else if (receipt?.dynamicFormalExecutionAuthority !== null) {
    blockers.push('formal_proof_search_dynamic_formal_authority_unexpected');
  }
  if (receipt?.status !== 'formal_proof_search_operations_semantic_review_only') {
    if (!eligibleDsl?.machineSearchEligible) blockers.push('formal_proof_search_operation_dsl_invalid');
    const expectedTactics = tacticSources(candidate?.strategy);
    if (receipt?.selectedTactic !== null && !expectedTactics.includes(receipt.selectedTactic)) {
      blockers.push('formal_proof_search_selected_tactic_invalid');
    }
    const operations = Array.isArray(receipt?.operationReceipts)
      ? receipt.operationReceipts : [];
    if (operations.some((operation, index) => operation?.tactic !== expectedTactics[index]
      || operation?.goalBeforeHash !== hashBytes(Buffer.from(
        eligibleDsl?.compiledLeanTypeSource || '',
        'utf8',
      ))
      || !verifyInfrastructureRetryLineage(operation)
      || (operation?.dockerWorkerContainerRecoveryReceipt
        && !verifyDockerWorkerContainerRecoveryReceipt(
          operation.dockerWorkerContainerRecoveryReceipt,
        ))
      || operation?.networkAccessAllowed !== false
      || !operation?.executionIdentity?.runtimeIdentityHash
      || operation?.executionIdentity?.runtimeExecutableSnapshotHash
        !== PRODUCTION_LAKE_EXECUTABLE_HASH
      || !operation?.executionProcessIdentityHash)) {
      blockers.push('formal_proof_search_tactic_execution_lineage_invalid');
    }
    const selected = operations.find((operation) => (
      operation?.formalProofStateTacticExecutionReceiptHash
        === receipt?.selectedTacticExecutionReceiptHash
    )) || null;
    const replay = receipt?.replayExecutionReceipt || null;
    if (receipt?.status === 'formal_proof_search_operations_verified'
      && (!selected || !replay
        || replay?.formalProofStateTacticExecutionReceiptHash
          !== receipt?.replayExecutionReceiptHash
        || !verifyInfrastructureRetryLineage(replay)
        || (replay?.dockerWorkerContainerRecoveryReceipt
          && !verifyDockerWorkerContainerRecoveryReceipt(
            replay.dockerWorkerContainerRecoveryReceipt,
          ))
        || replay?.executionIdentity?.runtimeExecutableSnapshotHash
          !== PRODUCTION_LAKE_EXECUTABLE_HASH
        || !replayMatches(selected, replay))) {
      blockers.push('formal_proof_search_replay_lineage_invalid');
    }
    const mathlibRequired = candidate?.requiredOperations
      ?.includes('pinned_mathlib_symbol_search') === true;
    const mathlibReceipt = receipt?.mathlibSymbolSearchReceipt;
    if (mathlibRequired) {
      if (!verifyPinnedMathlibSymbolSearchReceipt(mathlibReceipt, { dsl: eligibleDsl })) {
        blockers.push('formal_proof_search_mathlib_receipt_invalid');
      }
    } else if (mathlibReceipt !== null) blockers.push('formal_proof_search_mathlib_receipt_unexpected');
    const counterexampleRequired = candidate?.requiredOperations
      ?.includes('bounded_counterexample_search') === true;
    if (counterexampleRequired) {
      let rebuiltCounterexample = null;
      try { rebuiltCounterexample = searchTypedTheoremDslCounterexample(eligibleDsl); }
      catch { blockers.push('formal_proof_search_counterexample_rebuild_failed'); }
      if (!rebuiltCounterexample
        || JSON.stringify(receipt?.counterexampleSearchReceipts)
          !== JSON.stringify([rebuiltCounterexample])) {
        blockers.push('formal_proof_search_counterexample_receipt_invalid');
      }
    } else if ((receipt?.counterexampleSearchReceipts || []).length) {
      blockers.push('formal_proof_search_counterexample_receipt_unexpected');
    }
  }
  for (const operation of receipt?.operationReceipts || []) {
    if (!tacticReceiptHashValid(operation)
      || !(operation.infrastructureFailureReceipts || [])
        .every(tacticReceiptHashValid)) {
      blockers.push('formal_proof_search_tactic_receipt_hash_invalid');
    }
  }
  if (receipt?.replayExecutionReceipt) {
    if (!tacticReceiptHashValid(receipt.replayExecutionReceipt)
      || !(receipt.replayExecutionReceipt.infrastructureFailureReceipts || [])
        .every(tacticReceiptHashValid)) {
      blockers.push('formal_proof_search_replay_receipt_hash_invalid');
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'formal_proof_search_operation_receipt_blocked'
      : 'formal_proof_search_operation_receipt_verified',
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
