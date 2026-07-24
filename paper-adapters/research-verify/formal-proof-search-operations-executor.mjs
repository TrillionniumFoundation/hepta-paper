import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyFormalProofSearchPlan, verifyTypedTheoremObligationBundle } from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import { searchTypedTheoremDslCounterexample } from '../../paper-domain/research/typed-theorem-dsl.mjs';
import { PRODUCTION_LEAN_TOOLCHAIN } from '../../paper-domain/research/formal-verifier-policy.mjs';
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
const MAX_INDEX_FILES = 20_000;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const DECLARATION = /^\s*(?:theorem|lemma|def|abbrev|class|structure|inductive)\s+([A-Za-z_][A-Za-z0-9_'.]*)/gm;

export const FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO = Object.freeze({
  direct_elaboration: Object.freeze(['rfl']),
  mathlib_retrieval: Object.freeze(['simp', 'simpa', 'ext i <;> simp', 'aesop']),
  bounded_refutation_or_synthesis: Object.freeze([
    'omega', 'ring_nf', 'linarith', 'nlinarith', 'norm_num', 'positivity', 'aesop', 'simp',
  ]),
});

function tacticSources(strategy) {
  if (FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO[strategy]) {
    return FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO[strategy];
  }
  throw new Error('formal_proof_search_strategy_invalid');
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

function executionReceipt({ execution, source, tactic, goalBefore }) {
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
  return executionReceipt({
    execution,
    source,
    tactic,
    goalBefore: dsl.compiledLeanTypeSource,
  });
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

function mathlibFiles(root) {
  const candidate = path.join(root, '.lake', 'packages', 'mathlib');
  if (!fs.existsSync(candidate)) return [];
  const files = [];
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('formal_mathlib_index_symlink_forbidden');
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile() && entry.name.endsWith('.lean')) {
        bytes += stat.size;
        if (files.length >= MAX_INDEX_FILES || bytes > MAX_INDEX_BYTES) {
          throw new Error('formal_mathlib_index_size_exceeded');
        }
        const content = fs.readFileSync(absolute, 'utf8');
        files.push(Object.freeze({
          path: path.relative(candidate, absolute).replace(/\\/g, '/'),
          hash: hashBytes(Buffer.from(content, 'utf8')),
          content,
        }));
      }
    }
  };
  visit(candidate);
  return files;
}

function dslSearchTerms(dsl) {
  const values = new Set(dsl.binders.map((binder) => binder.domain.kind));
  const visitTerm = (term) => {
    values.add(term.kind);
    if (term.left) visitTerm(term.left);
    if (term.right) visitTerm(term.right);
  };
  for (const relation of [...dsl.assumptions, dsl.conclusion]) {
    values.add(relation.relation);
    visitTerm(relation.left);
    visitTerm(relation.right);
  }
  return [...values].sort();
}

export function buildPinnedMathlibSymbolSearchReceipt({ root, dsl }) {
  const query = dslSearchTerms(dsl);
  try {
    const files = mathlibFiles(root);
    const indexManifest = Object.freeze(files.map((file) => Object.freeze({
      path: file.path,
      hash: file.hash,
    })));
    const symbols = [];
    for (const file of files) {
      for (const match of file.content.matchAll(DECLARATION)) {
        symbols.push(Object.freeze({ name: match[1], sourcePath: file.path, sourceHash: file.hash }));
      }
    }
    const ranked = symbols.map((symbol) => ({
      ...symbol,
      score: query.filter((term) => symbol.name.toLowerCase().includes(term.toLowerCase())).length,
    })).filter((symbol) => symbol.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, 64);
    const payload = {
      version: 1,
      kind: 'PinnedMathlibSymbolSearchReceipt',
      status: files.length
        ? 'pinned_mathlib_symbol_search_completed'
        : 'pinned_mathlib_symbol_index_unavailable',
      query: Object.freeze(query),
      queryHash: hashRecord('PinnedMathlibSymbolSearchQuery', query),
      indexFileCount: files.length,
      indexManifest,
      indexManifestHash: hashRecord('PinnedMathlibSymbolIndexManifest', indexManifest),
      symbolCount: symbols.length,
      results: Object.freeze(ranked),
      resultHash: hashRecord('PinnedMathlibSymbolSearchResults', ranked),
      networkAccessAllowed: false,
      blockers: Object.freeze(files.length ? [] : ['pinned_mathlib_source_index_missing']),
    };
    return Object.freeze({
      ...payload,
      pinnedMathlibSymbolSearchReceiptHash:
        hashRecord('PinnedMathlibSymbolSearchReceipt', payload),
    });
  } catch (error) {
    const payload = {
      version: 1,
      kind: 'PinnedMathlibSymbolSearchReceipt',
      status: 'pinned_mathlib_symbol_search_blocked',
      query: Object.freeze(query),
      queryHash: hashRecord('PinnedMathlibSymbolSearchQuery', query),
      indexFileCount: 0,
      indexManifest: Object.freeze([]),
      indexManifestHash: null,
      symbolCount: 0,
      results: Object.freeze([]),
      resultHash: hashRecord('PinnedMathlibSymbolSearchResults', []),
      networkAccessAllowed: false,
      blockers: Object.freeze([String(error?.message || error)]),
    };
    return Object.freeze({
      ...payload,
      pinnedMathlibSymbolSearchReceiptHash:
        hashRecord('PinnedMathlibSymbolSearchReceipt', payload),
    });
  }
}

export function verifyPinnedMathlibSymbolSearchReceipt(receipt, { dsl } = {}) {
  const { pinnedMathlibSymbolSearchReceiptHash, ...payload } = receipt || {};
  const query = dslSearchTerms(dsl);
  const manifest = Array.isArray(receipt?.indexManifest) ? receipt.indexManifest : [];
  const results = Array.isArray(receipt?.results) ? receipt.results : [];
  const manifestByPath = new Map(manifest.map((entry) => [entry?.path, entry?.hash]));
  const expectedResults = results.map((entry) => ({
    ...entry,
    score: query.filter((term) => String(entry?.name || '').toLowerCase()
      .includes(term.toLowerCase())).length,
  })).sort((left, right) => right.score - left.score
    || String(left.name).localeCompare(String(right.name)));
  return receipt?.version === 1
    && receipt?.kind === 'PinnedMathlibSymbolSearchReceipt'
    && receipt?.status === 'pinned_mathlib_symbol_search_completed'
    && receipt?.networkAccessAllowed === false
    && Array.isArray(receipt?.blockers) && receipt.blockers.length === 0
    && JSON.stringify(receipt.query) === JSON.stringify(query)
    && receipt.queryHash === hashRecord('PinnedMathlibSymbolSearchQuery', query)
    && receipt.indexFileCount === manifest.length && manifest.length > 0
    && manifest.every((entry) => typeof entry?.path === 'string'
      && /^[^/](?:.*[^/])?\.lean$/.test(entry.path)
      && /^sha256:[0-9a-f]{64}$/.test(String(entry.hash || '')))
    && new Set(manifest.map((entry) => entry.path)).size === manifest.length
    && receipt.indexManifestHash
      === hashRecord('PinnedMathlibSymbolIndexManifest', manifest)
    && results.length <= 64
    && results.every((entry) => manifestByPath.get(entry?.sourcePath) === entry?.sourceHash
      && Number.isInteger(entry?.score) && entry.score > 0)
    && JSON.stringify(results) === JSON.stringify(expectedResults)
    && receipt.resultHash === hashRecord('PinnedMathlibSymbolSearchResults', results)
    && Number.isSafeInteger(receipt.symbolCount)
    && receipt.symbolCount >= results.length
    && pinnedMathlibSymbolSearchReceiptHash
      === hashRecord('PinnedMathlibSymbolSearchReceipt', payload);
}

function semanticReviewOnlyReceipt({ bundle, plan, candidate }) {
  const payload = {
    version: 1,
    kind: 'FormalProofSearchOperationReceipt',
    status: 'formal_proof_search_operations_semantic_review_only',
    typedTheoremObligationBundleHash: bundle.typedTheoremObligationBundleHash,
    formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
    candidateId: candidate.candidateId,
    strategy: candidate.strategy,
    operationReceipts: Object.freeze([]),
    mathlibSymbolSearchReceipt: null,
    counterexampleSearchReceipts: Object.freeze([]),
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
} = {}) {
  const workspaceRepository = createFormalProofSearchWorkspaceRepository({
    temporaryRoot,
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
  });
  return Object.freeze({
    version: 1,
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
        const pinned = resolvePinnedLakeExecutable({
          environment: dynamicFormalExecutionEnvironment,
          ...(dynamicFormalExecutionSpawnSync
            ? { spawnSyncImpl: dynamicFormalExecutionSpawnSync } : {}),
        });
        if (pinned.status !== 'formal_pinned_lake_resolved') {
          throw new Error(`formal_proof_search_pinned_lake_unavailable:${pinned.blockers.join(',')}`);
        }
        const runner = workerRunnerFactory({
          allowedExecutables: [pinned.executable],
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
        const mathlibSymbolSearchReceipt = candidate.requiredOperations
          .includes('pinned_mathlib_symbol_search')
          ? buildPinnedMathlibSymbolSearchReceipt({ root: project.root, dsl }) : null;
        const counterexampleSearchReceipts = candidate.requiredOperations
          .includes('bounded_counterexample_search')
          ? Object.freeze([searchTypedTheoremDslCounterexample(dsl)]) : Object.freeze([]);
        if (counterexampleSearchReceipts.some((receipt) => (
          receipt.status === 'bounded_counterexample_found'
        ))) {
          const payload = {
            version: 1,
            kind: 'FormalProofSearchOperationReceipt',
            status: 'formal_proof_search_counterexample_found',
            typedTheoremObligationBundleHash: bundle.typedTheoremObligationBundleHash,
            formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
            candidateId: candidate.candidateId,
            strategy: candidate.strategy,
            operationReceipts: Object.freeze([]),
            mathlibSymbolSearchReceipt,
            counterexampleSearchReceipts,
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
        const operationReceipts = [];
        let selected = null;
        for (const tactic of tacticSources(candidate.strategy)) {
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
          version: 1,
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
  if (receipt?.typedTheoremObligationBundleHash !== bundle?.typedTheoremObligationBundleHash
    || receipt?.formalProofSearchPlanHash !== plan?.formalProofSearchPlanHash
    || receipt?.candidateId !== candidate?.candidateId
    || receipt?.strategy !== candidate?.strategy) blockers.push('formal_proof_search_operation_authority_mismatch');
  if (receipt?.status === 'formal_proof_search_operations_semantic_review_only') {
    if (!allowSemanticReviewOnly || receipt.machineSearchEstablished !== false
      || receipt.semanticReviewOnly !== true) blockers.push('formal_proof_search_semantic_only_not_allowed');
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
      || operation?.networkAccessAllowed !== false
      || !operation?.executionIdentity?.runtimeIdentityHash
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
    const { formalProofStateTacticExecutionReceiptHash, ...operationPayload } = operation;
    if (hashRecord('FormalProofStateTacticExecutionReceipt', operationPayload)
      !== formalProofStateTacticExecutionReceiptHash) blockers.push('formal_proof_search_tactic_receipt_hash_invalid');
  }
  if (receipt?.replayExecutionReceipt) {
    const { formalProofStateTacticExecutionReceiptHash, ...replayPayload } =
      receipt.replayExecutionReceipt;
    if (hashRecord('FormalProofStateTacticExecutionReceipt', replayPayload)
      !== formalProofStateTacticExecutionReceiptHash) {
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
