import os from 'node:os';

import {
  searchTypedTheoremDslCounterexample,
} from '../../paper-domain/research/typed-theorem-dsl.mjs';
import {
  verifyTypedTheoremDependencyGraph,
} from '../../paper-domain/research/typed-theorem-dependency-graph.mjs';
import {
  PRODUCTION_LEAN_RUNTIME_LAYOUTS,
  PRODUCTION_LEAN_TOOLCHAIN,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';
import {
  assertCurrentDynamicFormalExecutionAuthority,
  verifyDynamicFormalExecutionAuthority,
} from './dynamic-formal-project-closure-readiness.mjs';
import {
  createFormalProofSearchWorkspaceRepository,
  verifyFormalExecutionSnapshotReceipt,
} from './formal-proof-search-workspace-repository.mjs';
import { resolvePinnedLakeExecutable } from './pinned-lake-executable-resolver.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const PRODUCTION_LAKE_EXECUTABLE_HASH =
  PRODUCTION_LEAN_RUNTIME_LAYOUTS[PRODUCTION_LEAN_TOOLCHAIN].lakeExecutableHash;

function tacticCandidates(strategy, dependencyNames, binderNames) {
  const argumentsSource = binderNames.length ? ` ${binderNames.join(' ')}` : '';
  const dependencyTactics = dependencyNames.flatMap((name) => [
    `exact ${name}${argumentsSource}`,
    `simpa using ${name}${argumentsSource}`,
  ]);
  if (strategy === 'direct_elaboration') return Object.freeze([...dependencyTactics, 'rfl']);
  if (strategy === 'mathlib_retrieval') return Object.freeze([...dependencyTactics, 'simp']);
  if (strategy === 'bounded_refutation_or_synthesis') {
    return Object.freeze([...dependencyTactics, 'omega', 'aesop', 'simp']);
  }
  throw new Error('formal_theorem_dependency_graph_strategy_invalid');
}

function dependencyClosure(graph, node, verifiedByClaimId) {
  const selected = new Set();
  const visit = (claimId) => {
    if (selected.has(claimId)) return;
    const dependencyNode = graph.nodes.find((item) => item.claimId === claimId);
    if (!dependencyNode || verifiedByClaimId.get(claimId)?.status
      !== 'formal_theorem_dependency_operation_verified') {
      throw new Error('formal_theorem_dependency_import_not_kernel_verified');
    }
    for (const dependency of dependencyNode.dependencyClaimIds) visit(dependency);
    selected.add(claimId);
  };
  for (const dependency of node.dependencyClaimIds) visit(dependency);
  return graph.topologicalOrder.filter((claimId) => selected.has(claimId));
}

function leanSource({ imports, graph, node, verifiedByClaimId, tactic }) {
  const closure = dependencyClosure(graph, node, verifiedByClaimId);
  const declarations = closure.map((claimId) => {
    const dependencyNode = graph.nodes.find((item) => item.claimId === claimId);
    const receipt = verifiedByClaimId.get(claimId);
    const introductionNames = [
      ...dependencyNode.typedTheoremDsl.binders.map((binder) => binder.name),
      ...dependencyNode.typedTheoremDsl.assumptions.map(
        (_, index) => `heptaAssumption${index + 1}`,
      ),
    ];
    return [
      `theorem ${dependencyNode.leanDeclarationName} : ${receipt.compiledLeanTypeSource} := by`,
      ...(introductionNames.length ? [`  intro ${introductionNames.join(' ')}`] : []),
      `  ${receipt.selectedTactic}`,
      '',
    ].join('\n');
  });
  const introductionNames = [
    ...node.typedTheoremDsl.binders.map((binder) => binder.name),
    ...node.typedTheoremDsl.assumptions.map((_, index) => `heptaAssumption${index + 1}`),
  ];
  return [
    ...imports.map((moduleName) => `import ${moduleName}`),
    '',
    ...declarations,
    `example : ${node.typedTheoremDsl.compiledLeanTypeSource} := by`,
    '  trace_state',
    ...(introductionNames.length ? [`  intro ${introductionNames.join(' ')}`] : []),
    `  ${tactic}`,
    '  all_goals trace_state',
    '',
  ].join('\n');
}

function executionIdentity(execution) {
  return Object.freeze({
    runnerId: execution?.runnerId || null,
    backend: execution?.backend || null,
    runtimeIdentityHash: execution?.runtimeIdentityHash || null,
    runtimeExecutableSnapshotHash: execution?.runtimeExecutableSnapshotHash || null,
    containerImageDigest: execution?.containerImageDigest || null,
    executionProcessIdentityHash: execution?.executionProcessIdentityHash || null,
  });
}

function tacticReceipt({
  execution,
  source,
  tactic,
  phase,
  initialFormalExecutionSnapshotReceipt = null,
  finalFormalExecutionSnapshotReceipt = null,
}) {
  const payload = {
    version: 1,
    kind: 'FormalTheoremDependencyTacticReceipt',
    status: execution?.ok
      ? 'formal_theorem_dependency_tactic_closed'
      : execution?.blockers?.includes('os_sandbox_command_timed_out')
        ? 'formal_theorem_dependency_tactic_timed_out'
        : 'formal_theorem_dependency_tactic_failed',
    phase,
    tactic,
    sourceHash: hashBytes(Buffer.from(source, 'utf8')),
    exitCode: Number.isInteger(execution?.exitCode) ? execution.exitCode : null,
    signal: execution?.signal || null,
    stdoutHash: hashBytes(Buffer.from(String(execution?.stdout || ''), 'utf8')),
    stderrHash: hashBytes(Buffer.from(String(execution?.stderr || ''), 'utf8')),
    executionIdentity: executionIdentity(execution),
    immutableWorkRootVerified:
      execution?.isolation?.immutableWorkRootVerified === true,
    initialFormalExecutionSnapshotReceipt,
    finalFormalExecutionSnapshotReceipt,
    networkAccessAllowed: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    formalTheoremDependencyTacticReceiptHash:
      hashRecord('FormalTheoremDependencyTacticReceipt', payload),
  });
}

function replayMatches(original, replay) {
  return original.status === replay.status
    && original.tactic === replay.tactic
    && original.sourceHash === replay.sourceHash
    && original.exitCode === replay.exitCode
    && original.stdoutHash === replay.stdoutHash
    && original.stderrHash === replay.stderrHash
    && original.executionIdentity.runtimeIdentityHash
      === replay.executionIdentity.runtimeIdentityHash
    && original.executionIdentity.containerImageDigest
      === replay.executionIdentity.containerImageDigest
    && original.executionIdentity.executionProcessIdentityHash
      !== replay.executionIdentity.executionProcessIdentityHash;
}

async function runLean({
  runner, executable, repository, projectRoot, projectScopeRoot, graph, node, verifiedByClaimId,
  imports, tactic, timeoutMs, signal, phase, executionEnvironment,
  requireImmutableWorkRoot, dynamicExecutionFactory = null,
}) {
  const source = leanSource({ imports, graph, node, verifiedByClaimId, tactic });
  const relative = `HeptaGraph-${node.claimId.slice(-12)}-${hashBytes(Buffer.from(tactic)).slice(7, 15)}.lean`;
  let dynamicExecution = null;
  if (dynamicExecutionFactory) {
    dynamicExecution = await dynamicExecutionFactory({ relative, source });
  } else repository.stageLeanSource({ projectRoot, relative, source });
  let execution;
  let finalFormalExecutionSnapshotReceipt = null;
  try {
    execution = await (dynamicExecution?.runner || runner).run({
      executable,
      args: ['env', 'lean', relative],
      cwd: dynamicExecution?.projectRoot || projectRoot,
      sourceRoot: dynamicExecution?.projectScopeRoot || projectScopeRoot,
      timeoutMs,
      outputPaths: [],
      env: {
        ELAN_HOME: executionEnvironment.ELAN_HOME
          || `${executionEnvironment.HOME || ''}/.elan`,
        ELAN_TOOLCHAIN: PRODUCTION_LEAN_TOOLCHAIN,
      },
      language: 'lean',
      determinismPolicy: 'typed-theorem-dependency-graph-v1',
      requireImmutableWorkRoot,
      signal,
    });
  } finally {
    if (dynamicExecution) {
      finalFormalExecutionSnapshotReceipt = dynamicExecution.finalize();
    }
  }
  return tacticReceipt({
    execution,
    source,
    tactic,
    phase,
    initialFormalExecutionSnapshotReceipt:
      dynamicExecution?.initialFormalExecutionSnapshotReceipt || null,
    finalFormalExecutionSnapshotReceipt,
  });
}

function theoremOperationReceipt({
  graph, node, dependencyReceipts, status, tacticReceipts = [], replayReceipt = null,
  selectedTactic = null, counterexampleReceipt = null, blockers = [],
}) {
  const payload = {
    version: 1,
    kind: 'FormalTheoremDependencyOperationReceipt',
    status,
    typedTheoremDependencyGraphHash: graph.typedTheoremDependencyGraphHash,
    graphSemanticHash: graph.graphSemanticHash,
    claimId: node.claimId,
    typedTheoremDependencyNodeHash: node.typedTheoremDependencyNodeHash,
    dependencyClaimIds: node.dependencyClaimIds,
    dependencyOperationReceiptHashes: Object.freeze(dependencyReceipts.map((item) => (
      item.formalTheoremDependencyOperationReceiptHash
    ))),
    importedDeclarationNames: Object.freeze(dependencyReceipts.map((item) => (
      item.leanDeclarationName
    ))),
    leanDeclarationName: node.leanDeclarationName,
    compiledLeanTypeSource: node.typedTheoremDsl?.compiledLeanTypeSource || null,
    compiledLeanNormalizedTypeHash:
      node.typedTheoremDsl?.compiledLeanNormalizedTypeHash || null,
    tacticReceiptHashes: Object.freeze(tacticReceipts.map((item) => (
      item.formalTheoremDependencyTacticReceiptHash
    ))),
    tacticReceipts: Object.freeze(tacticReceipts),
    selectedTactic,
    replayReceiptHash: replayReceipt?.formalTheoremDependencyTacticReceiptHash || null,
    replayReceipt,
    replayMatched: Boolean(replayReceipt && tacticReceipts.some((item) => (
      replayMatches(item, replayReceipt)
    ))),
    counterexampleReceipt,
    kernelVerifiedBeforeDownstreamImport:
      status === 'formal_theorem_dependency_operation_verified',
    semanticReviewOnly: status === 'formal_theorem_dependency_operation_semantic_review_only',
    blockers: Object.freeze([...new Set(blockers.map(String))].sort()),
    networkAccessAllowed: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    formalTheoremDependencyOperationReceiptHash:
      hashRecord('FormalTheoremDependencyOperationReceipt', payload),
  });
}

export function createFormalTheoremDependencyGraphOperationsExecutor({
  trustedSandboxRuntime = null,
  temporaryRoot = os.tmpdir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workerRunnerFactory = createOsSandboxedWorkerRunner,
  dynamicFormalExecutionAuthority = null,
  dynamicFormalExecutionEnvironment = process.env,
  dynamicFormalExecutionSpawnSync = undefined,
  resolvePinnedRuntime = resolvePinnedLakeExecutable,
} = {}) {
  const repository = createFormalProofSearchWorkspaceRepository({
    temporaryRoot,
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
  });
  return Object.freeze({
    version: 1,
    kind: 'FormalTheoremDependencyGraphOperationsExecutor',
    async execute({ theoremSpecification, bundle, graph, candidate, workspace = null, signal = null } = {}) {
      if (!verifyTypedTheoremDependencyGraph(graph, { theoremSpecification, bundle }).valid) {
        throw new Error('formal_theorem_dependency_graph_authority_invalid');
      }
      const imports = Object.freeze([...new Set(graph.nodes.flatMap((node) => (
        node.typedTheoremDsl?.allowedImports || []
      )))].sort());
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
      const project = activeAuthority ? null : await repository.materialize({
        workspace,
        dependencyScopeRoot: workspace,
        imports,
      });
      try {
        const initialFormalExecutionSnapshotReceipt = project
          ? repository.assertExecutionSnapshotCurrent({ projectRoot: project.root }) : null;
        const pinned = resolvePinnedRuntime({
          environment: dynamicFormalExecutionEnvironment,
        });
        if (pinned.status !== 'formal_pinned_lake_resolved') {
          throw new Error(`formal_theorem_dependency_lake_unavailable:${pinned.blockers.join(',')}`);
        }
        const createRunner = (executionProject) => workerRunnerFactory({
          allowedExecutables: [pinned.executable],
          expectedExecutableHashes: {
            [pinned.executable]: pinned.lakeExecutableHash,
          },
          allowedRoots: [executionProject.scopeRoot],
          ...(trustedSandboxRuntime ? {
            dockerImage: trustedSandboxRuntime.image,
            allowedContainerImages: [trustedSandboxRuntime.image],
          } : {}),
          maximumTimeoutMs: timeoutMs,
          maximumCpuSeconds: Math.ceil(timeoutMs / 1000),
          maximumPids: 64,
          maximumCapturedBytes: 2 * 1024 * 1024,
        });
        const runner = project ? createRunner(project) : null;
        const dynamicExecutionFactory = activeAuthority
          ? async ({ relative, source }) => {
            const dynamicProject = await repository.materialize({
              workspace: activeAuthority.projectRoot,
              dependencyScopeRoot: activeAuthority.projectScopeRoot,
              expectedFormalProjectClosureHash:
                activeAuthority.formalProjectClosureHash,
              imports,
            });
            try {
              repository.stageLeanSource({
                projectRoot: dynamicProject.root,
                relative,
                source,
              });
              repository.sealExecutionSnapshot({ projectRoot: dynamicProject.root });
              const initialReceipt = repository.assertExecutionSnapshotCurrent({
                projectRoot: dynamicProject.root,
              });
              return Object.freeze({
                projectRoot: dynamicProject.root,
                projectScopeRoot: dynamicProject.scopeRoot,
                runner: createRunner(dynamicProject),
                initialFormalExecutionSnapshotReceipt: initialReceipt,
                finalize() {
                  try {
                    assertCurrentDynamicFormalExecutionAuthority(
                      activeAuthority,
                      authorityOptions,
                    );
                    return repository.assertExecutionSnapshotCurrent({
                      projectRoot: dynamicProject.root,
                    });
                  } finally {
                    dynamicProject.cleanup();
                  }
                },
              });
            } catch (error) {
              dynamicProject.cleanup();
              throw error;
            }
          } : null;
        const verified = new Map();
        const receipts = [];
        for (const claimId of graph.topologicalOrder) {
          const node = graph.nodes.find((item) => item.claimId === claimId);
          const dependencyReceipts = node.dependencyClaimIds.map((item) => verified.get(item));
          if (dependencyReceipts.some((item) => !item
            || item.status !== 'formal_theorem_dependency_operation_verified')) {
            const receipt = theoremOperationReceipt({
              graph, node, dependencyReceipts: dependencyReceipts.filter(Boolean),
              status: 'formal_theorem_dependency_operation_blocked_by_dependency',
              blockers: ['formal_theorem_dependency_predecessor_not_kernel_verified'],
            });
            verified.set(claimId, receipt);
            receipts.push(receipt);
            continue;
          }
          if (!node.machineSearchEligible) {
            const receipt = theoremOperationReceipt({
              graph, node, dependencyReceipts,
              status: 'formal_theorem_dependency_operation_semantic_review_only',
              blockers: ['typed_theorem_dsl_machine_search_not_available'],
            });
            verified.set(claimId, receipt);
            receipts.push(receipt);
            continue;
          }
          const counterexampleReceipt = candidate?.requiredOperations
            ?.includes('bounded_counterexample_search')
            ? searchTypedTheoremDslCounterexample(node.typedTheoremDsl) : null;
          if (counterexampleReceipt?.status === 'bounded_counterexample_found') {
            const receipt = theoremOperationReceipt({
              graph, node, dependencyReceipts,
              status: 'formal_theorem_dependency_operation_refuted',
              counterexampleReceipt,
              blockers: ['formal_proof_search_refuted_by_bounded_witness'],
            });
            verified.set(claimId, receipt);
            receipts.push(receipt);
            continue;
          }
          const dependencyNames = dependencyReceipts.map((item) => item.leanDeclarationName);
          const tacticReceipts = [];
          let selected = null;
          for (const tactic of tacticCandidates(
            candidate?.strategy,
            dependencyNames,
            node.typedTheoremDsl.binders.map((binder) => binder.name),
          )) {
            const receipt = await runLean({
              runner, executable: pinned.executable, repository, projectRoot: project?.root,
              projectScopeRoot: project?.scopeRoot,
              graph, node, verifiedByClaimId: verified, imports, tactic, timeoutMs, signal,
              phase: 'original', executionEnvironment: dynamicFormalExecutionEnvironment,
              requireImmutableWorkRoot: Boolean(activeAuthority),
              dynamicExecutionFactory,
            });
            tacticReceipts.push(receipt);
            if (receipt.status === 'formal_theorem_dependency_tactic_closed') {
              selected = receipt;
              break;
            }
          }
          const replay = selected ? await runLean({
            runner, executable: pinned.executable, repository, projectRoot: project?.root,
            projectScopeRoot: project?.scopeRoot,
            graph, node, verifiedByClaimId: verified, imports, tactic: selected.tactic,
            timeoutMs, signal, phase: 'replay',
            executionEnvironment: dynamicFormalExecutionEnvironment,
            requireImmutableWorkRoot: Boolean(activeAuthority),
            dynamicExecutionFactory,
          }) : null;
          const matched = Boolean(selected && replay && replayMatches(selected, replay));
          const receipt = theoremOperationReceipt({
            graph, node, dependencyReceipts, tacticReceipts,
            replayReceipt: replay,
            selectedTactic: selected?.tactic || null,
            counterexampleReceipt,
            status: matched
              ? 'formal_theorem_dependency_operation_verified'
              : 'formal_theorem_dependency_operation_search_exhausted',
            blockers: matched ? [] : ['formal_theorem_dependency_no_replayed_kernel_candidate'],
          });
          verified.set(claimId, receipt);
          receipts.push(receipt);
        }
        const payload = {
          version: 1,
          kind: 'FormalTheoremDependencyGraphOperationReceipt',
          status: receipts.every((item) => (
            item.status === 'formal_theorem_dependency_operation_verified'
          )) ? 'formal_theorem_dependency_graph_operations_verified'
            : 'formal_theorem_dependency_graph_operations_partial',
          typedTheoremDependencyGraphHash: graph.typedTheoremDependencyGraphHash,
          graphSemanticHash: graph.graphSemanticHash,
          candidateId: candidate?.candidateId || null,
          strategy: candidate?.strategy || null,
          topologicalOrder: graph.topologicalOrder,
          theoremOperationReceiptHashes: Object.freeze(receipts.map((item) => (
            item.formalTheoremDependencyOperationReceiptHash
          ))),
          theoremOperationReceipts: Object.freeze(receipts),
          freshReplayComplete: receipts.filter((item) => nodeMachine(item, graph)).every((item) => (
            item.replayMatched === true
          )),
          dynamicFormalExecutionAuthority: activeAuthority,
          initialFormalExecutionSnapshotReceipt,
          finalFormalExecutionSnapshotReceipt: null,
          networkAccessAllowed: false,
          externalActionPerformed: false,
        };
        if (activeAuthority) {
          assertCurrentDynamicFormalExecutionAuthority(activeAuthority, authorityOptions);
        }
        payload.finalFormalExecutionSnapshotReceipt = project
          ? repository.assertExecutionSnapshotCurrent({ projectRoot: project.root }) : null;
        return Object.freeze({
          ...payload,
          formalTheoremDependencyGraphOperationReceiptHash:
            hashRecord('FormalTheoremDependencyGraphOperationReceipt', payload),
        });
      } finally {
        project?.cleanup();
      }
    },
  });
}

function nodeMachine(receipt, graph) {
  return graph.nodes.find((item) => item.claimId === receipt.claimId)?.machineSearchEligible === true;
}

export function verifyFormalTheoremDependencyGraphOperationReceipt(value, {
  graph,
  candidate = null,
  expectedDynamicFormalExecutionAuthority = null,
} = {}) {
  const blockers = [];
  const { formalTheoremDependencyGraphOperationReceiptHash: claimedHash, ...payload } = value || {};
  const receipts = Array.isArray(value?.theoremOperationReceipts)
    ? value.theoremOperationReceipts : [];
  const dynamicFormalRequired = graph?.nodes?.some((node) => (
    node.typedTheoremDsl?.allowedImports?.some((moduleName) => (
      moduleName === 'Mathlib' || moduleName.startsWith('Mathlib.')
    )) === true
  )) === true;
  if (dynamicFormalRequired) {
    if (!verifyDynamicFormalExecutionAuthority(value?.dynamicFormalExecutionAuthority)) {
      blockers.push('formal_theorem_dependency_dynamic_formal_authority_invalid');
    } else if (expectedDynamicFormalExecutionAuthority
      && JSON.stringify(value.dynamicFormalExecutionAuthority)
        !== JSON.stringify(expectedDynamicFormalExecutionAuthority)) {
      blockers.push('formal_theorem_dependency_dynamic_formal_authority_mismatch');
    }
    const expectedImageDigest = value?.dynamicFormalExecutionAuthority
      ?.formalSandboxRuntimeImageDigest;
    const dynamicTacticReceipts = receipts.flatMap((receipt) => (
      [...(receipt?.tacticReceipts || []), receipt?.replayReceipt].filter(Boolean)
    ));
    if (dynamicTacticReceipts.some((tactic) => (
      tactic?.executionIdentity?.containerImageDigest !== expectedImageDigest
        || tactic?.immutableWorkRootVerified !== true
    ))) {
      blockers.push('formal_theorem_dependency_dynamic_formal_sandbox_identity_mismatch');
    }
    if (dynamicTacticReceipts.some((tactic) => (
      !verifyFormalExecutionSnapshotReceipt(
        tactic?.initialFormalExecutionSnapshotReceipt,
        {
          formalProjectClosureHash:
            value.dynamicFormalExecutionAuthority.formalProjectClosureHash,
          formalProjectManifestHash:
            value.dynamicFormalExecutionAuthority.formalProjectManifestHash,
        },
      ) || !verifyFormalExecutionSnapshotReceipt(
        tactic?.finalFormalExecutionSnapshotReceipt,
        {
          formalProjectClosureHash:
            value.dynamicFormalExecutionAuthority.formalProjectClosureHash,
          formalProjectManifestHash:
            value.dynamicFormalExecutionAuthority.formalProjectManifestHash,
        },
      )
    ))) {
      blockers.push('formal_theorem_dependency_execution_snapshot_receipt_invalid');
    }
  } else if (value?.dynamicFormalExecutionAuthority !== null) {
    blockers.push('formal_theorem_dependency_dynamic_formal_authority_unexpected');
  }
  if (claimedHash !== hashRecord('FormalTheoremDependencyGraphOperationReceipt', payload)
    || value?.typedTheoremDependencyGraphHash !== graph?.typedTheoremDependencyGraphHash
    || value?.graphSemanticHash !== graph?.graphSemanticHash
    || (candidate && (value?.candidateId !== candidate.candidateId
      || value?.strategy !== candidate.strategy))
    || JSON.stringify(value?.topologicalOrder) !== JSON.stringify(graph?.topologicalOrder)
    || JSON.stringify(receipts.map((item) => item.claimId))
      !== JSON.stringify(graph?.topologicalOrder)
    || JSON.stringify(value?.theoremOperationReceiptHashes)
      !== JSON.stringify(receipts.map((item) => item.formalTheoremDependencyOperationReceiptHash))) {
    blockers.push('formal_theorem_dependency_graph_operation_shape_invalid');
  }
  const byId = new Map();
  for (const receipt of receipts) {
    const { formalTheoremDependencyOperationReceiptHash: receiptHash, ...receiptPayload } = receipt;
    const node = graph?.nodes?.find((item) => item.claimId === receipt.claimId);
    const dependencies = node?.dependencyClaimIds.map((claimId) => byId.get(claimId)) || [];
    if (!node || receiptHash !== hashRecord('FormalTheoremDependencyOperationReceipt', receiptPayload)
      || receipt.typedTheoremDependencyNodeHash !== node.typedTheoremDependencyNodeHash
      || JSON.stringify(receipt.dependencyOperationReceiptHashes)
        !== JSON.stringify(dependencies.map((item) => item?.formalTheoremDependencyOperationReceiptHash))
      || receipt.networkAccessAllowed !== false || receipt.externalActionPerformed !== false) {
      blockers.push(`formal_theorem_dependency_operation_invalid:${receipt.claimId || 'missing'}`);
    }
    if (receipt.status === 'formal_theorem_dependency_operation_verified') {
      const selected = receipt.tacticReceipts.find((item) => (
        item.tactic === receipt.selectedTactic
          && item.status === 'formal_theorem_dependency_tactic_closed'
      ));
      if (!selected || !receipt.replayReceipt || !replayMatches(selected, receipt.replayReceipt)
        || receipt.kernelVerifiedBeforeDownstreamImport !== true
        || dependencies.some((item) => item.status
          !== 'formal_theorem_dependency_operation_verified')) {
        blockers.push(`formal_theorem_dependency_kernel_lineage_invalid:${receipt.claimId}`);
      }
    }
    for (const tactic of [...(receipt.tacticReceipts || []), receipt.replayReceipt].filter(Boolean)) {
      const { formalTheoremDependencyTacticReceiptHash: tacticHash, ...tacticPayload } = tactic;
      if (tacticHash !== hashRecord('FormalTheoremDependencyTacticReceipt', tacticPayload)
        || tactic.networkAccessAllowed !== false
        || tactic.executionIdentity?.runtimeExecutableSnapshotHash
          !== PRODUCTION_LAKE_EXECUTABLE_HASH) {
        blockers.push(`formal_theorem_dependency_tactic_receipt_invalid:${receipt.claimId}`);
      }
    }
    byId.set(receipt.claimId, receipt);
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'formal_theorem_dependency_graph_operation_blocked'
      : 'formal_theorem_dependency_graph_operation_verified',
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
