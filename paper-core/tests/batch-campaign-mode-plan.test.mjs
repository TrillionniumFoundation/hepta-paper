import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBatchCampaignCommand } from '../../paper-application/automation/batch-campaign-command.mjs';
import { deriveCampaignNodeExecutionContext } from '../../paper-application/automation/campaign-node-execution-context.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { buildCampaignModeNodes, plannedAgentCallUpperBound } from '../../paper-domain/automation/campaign-mode-graph.mjs';
import { evaluateCampaignReleaseTopology } from '../../paper-domain/automation/campaign-release-topology-policy.mjs';
import { PAPER_MODE_REGISTRY } from '../../paper-domain/workflow/mode-registry.mjs';
import { assertCampaignDefinition } from '../../paper-adapters/persistence/campaign-definition-codec.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PAPER = Object.freeze({
  version: 'fixture',
  kind: 'PaperTask',
  paperId: 'paper-1',
  taskKey: 'paper-factory:paper-1',
  semanticIdentityHash: `sha256:${'1'.repeat(64)}`,
  venueTarget: 'Registry Venue',
  evidenceRefs: Object.freeze([]),
});

const SCOPE = Object.freeze({
  status: 'target_scope_verified',
  requestedPaperIds: Object.freeze(['paper-1']),
  selectedPaperIds: Object.freeze(['paper-1']),
  inventorySource: 'yaml',
  inventoryFallback: null,
});

function plan(mode, overrides = {}) {
  return buildPaperCampaignPlan({
    paperId: PAPER.paperId,
    sourceWorkspace: '/papers/paper-1',
    campaignId: `campaign-${mode}`,
    mode,
    maxRounds: 2,
    refereeCount: 2,
    paperTask: PAPER,
    paperState: { evidenceRefs: [] },
    ...overrides,
  });
}

function roundKinds(value) {
  return value.nodes.map((node) => `${node.roundIndex}:${node.kind}`);
}

test('mode registry contains command vocabulary only, never an alternate stage graph', () => {
  assert.ok(Object.values(PAPER_MODE_REGISTRY).every((definition) => !Object.hasOwn(definition, 'stages')));
});

test('each executable batch mode maps to an explicit bounded campaign graph', () => {
  const cases = new Map([
    ['local-build', ['0:compile']],
    ['local-package', ['0:final-compile', '0:research-verify', '1:package']],
    ['research-verify', ['0:research-verify']],
    ['referee-review', ['1:referee-1', '1:referee-2']],
    ['referee-revise', [
      '1:referee-1', '1:referee-2', '1:revise', '1:revalidate-compile',
      '1:revalidate-citations', '1:revalidate-artifacts', '1:final-compile',
    ]],
    ['empirical-analysis', ['0:research-plan', '0:coder', '0:empirical', '0:empirical-reproduce']],
    ['local-dry-run', ['0:final-compile', '0:research-verify', '1:referee-1', '1:referee-2', '2:package']],
  ]);
  for (const [mode, expected] of cases) {
    const value = plan(mode, mode === 'empirical-analysis' ? { languages: ['python', 'latex'] } : {});
    assert.deepEqual(roundKinds(value), expected, mode);
    assert.equal(value.requestedMode, mode);
    assert.equal(value.mode, mode);
    assert.ok(value.nodes.every((node) => node.executionIntent.requestedMode === mode));
  }

  const reviewLoop = plan('local-review-loop');
  assert.equal(reviewLoop.nodes.length, 20);
  assert.deepEqual(reviewLoop.nodes.filter((node) => node.kind === 'convergence').map((node) => node.roundIndex), [1, 2]);
  assert.equal(reviewLoop.nodes.at(-1).kind, 'final-compile');

  const alias = plan('referee-autopilot');
  assert.equal(alias.requestedMode, 'local-review-loop');
  assert.equal(alias.mode, 'local-review-loop');
  assert.deepEqual(roundKinds(alias), roundKinds(reviewLoop));
  const canonicalIdentity = plan('local-review-loop', { campaignId: 'campaign-review-loop-alias' });
  const aliasIdentity = plan('referee-autopilot', { campaignId: 'campaign-review-loop-alias' });
  assert.deepEqual(aliasIdentity, canonicalIdentity);

  const reviewedSubmit = plan('reviewed-submit');
  assert.equal(reviewedSubmit.releaseHandoffRequired, true);
  assert.equal(reviewedSubmit.externalSubmissionEnabled, false);
  assert.deepEqual(roundKinds(reviewedSubmit), ['0:final-compile', '0:research-verify', '1:package']);
  assert.notDeepEqual(roundKinds(reviewedSubmit), roundKinds(reviewLoop));
  assert.throws(
    () => plan('reviewed-submit', { applyManuscript: true }),
    /campaign_empirical_options_not_supported_for_mode:reviewed-submit/,
  );
});

test('formal full campaign creates a system-finalized theorem spec and an atomic author-review-machine candidate before research release', () => {
  const value = plan('full-campaign', {
    paperQualityProfile: 'formal_theorem_or_proof',
    languages: ['lean', 'latex'],
  });
  const kinds = value.nodes.map((item) => item.kind);
  assert.ok(kinds.includes('theorem-spec'));
  assert.equal(kinds.includes('formal-author'), false);
  assert.equal(kinds.includes('formal-review'), false);
  assert.ok(kinds.includes('formal-verify'));
  assert.ok(kinds.includes('research-verify'));
  assert.equal(kinds.some((kind) => /^empirical(?:-reproduce)?(?:-|$)/.test(kind)), false);
  const formalVerifications = value.nodes.filter((item) => item.kind === 'formal-verify');
  const formalVerify = [...formalVerifications]
    .sort((left, right) => right.roundIndex - left.roundIndex)[0];
  const theoremSpecification = value.nodes.find((item) => item.nodeId === formalVerify.dependencies[0]);
  const finalCompile = value.nodes.find((item) => item.kind === 'final-compile');
  const researchVerify = value.nodes.find((item) => item.kind === 'research-verify');
  const packageNode = value.nodes.find((item) => item.kind === 'package');
  assert.equal(theoremSpecification.kind, 'theorem-spec');
  assert.deepEqual(formalVerify.dependencies, [theoremSpecification.nodeId]);
  assert.deepEqual(researchVerify.dependencies, [finalCompile.nodeId, ...formalVerifications.map((item) => item.nodeId)]);
  assert.deepEqual(packageNode.dependencies, [finalCompile.nodeId, researchVerify.nodeId]);
  assert.equal(value.budgets.maxAgentCalls, Math.max(30, plannedAgentCallUpperBound(value.nodes)));
  assert.ok(value.budgets.maxAgentCalls > 30);
  const sourceClosureFormal = formalVerifications.filter((item) => item.sourceClosureTerminal === true);
  assert.equal(sourceClosureFormal.length, 1);
  assert.equal(sourceClosureFormal[0].roundIndex, 0);
  assert.ok(sourceClosureFormal[0].nodeId.endsWith(':source-closure-formal-verify'));
  assert.ok(sourceClosureFormal[0].dependencies[0].endsWith(':source-closure-theorem-spec'));
  assert.ok(finalCompile.dependencies.includes(sourceClosureFormal[0].nodeId));
  assert.equal(finalCompile.sourceClosureTerminal, true);
  assert.equal(finalCompile.sourceMutationPolicy, 'forbid');
  assert.ok(researchVerify.dependencies.includes(sourceClosureFormal[0].nodeId));
  const intentionallyBounded = plan('full-campaign', {
    paperQualityProfile: 'formal_theorem_or_proof', languages: ['lean', 'latex'],
    budgets: { maxAgentCalls: 7 },
  });
  assert.equal(intentionallyBounded.budgets.maxAgentCalls, 7);
});

test('formal full DAG brackets every trusted manuscript mutation and closes release over the final source', () => {
  const nodes = buildCampaignModeNodes({
    campaignId: 'campaign-formal-render-fence',
    mode: 'full-campaign',
    rounds: 2,
    reviewers: 2,
    executionProfiles: [],
    executionIntent: { kind: 'DynamicFormalFullDagFixture' },
    empiricalRequested: false,
    applyManuscript: true,
    formalRequested: true,
    researchVerificationRequired: true,
  });
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const renderAuthorityFormal = nodes.find((node) => (
    node.kind === 'formal-verify' && node.nodeId.endsWith(':render-authority-formal-verify')
  ));
  const integrate = nodes.find((node) => node.kind === 'manuscript-integrate');
  assert.ok(renderAuthorityFormal && integrate);
  assert.ok(integrate.dependencies.includes(renderAuthorityFormal.nodeId));
  assert.equal(byId.get(renderAuthorityFormal.dependencies[0]).kind, 'theorem-spec');

  const completedNodes = nodes.map((node) => ({
    ...node,
    status: node.kind === 'formal-verify' ? 'completed' : 'queued',
    result: node.kind === 'formal-verify'
      ? { kind: 'CampaignFormalVerificationReceipt', nodeId: node.nodeId }
      : null,
  }));
  const integrateContext = deriveCampaignNodeExecutionContext({
    node: integrate,
    allNodes: completedNodes,
  });
  assert.equal(integrateContext.formalVerificationNode.nodeId, renderAuthorityFormal.nodeId);

  const integratedTheorem = nodes.find((node) => (
    node.kind === 'theorem-spec' && node.dependencies.includes(integrate.nodeId)
  ));
  const integratedFormal = nodes.find((node) => (
    node.kind === 'formal-verify' && node.dependencies.includes(integratedTheorem?.nodeId)
  ));
  const initialCompile = nodes.find((node) => node.kind === 'compile');
  assert.ok(integratedTheorem && integratedFormal && initialCompile);
  assert.deepEqual(initialCompile.dependencies, [integratedFormal.nodeId]);

  let latestPostMutationFormal = integratedFormal;
  const revisions = nodes.filter((node) => node.kind === 'revise')
    .sort((left, right) => left.roundIndex - right.roundIndex);
  assert.equal(revisions.length, 2);
  for (const revision of revisions) {
    assert.ok(revision.dependencies.includes(latestPostMutationFormal.nodeId));
    const revisionContext = deriveCampaignNodeExecutionContext({
      node: revision,
      allNodes: completedNodes,
    });
    assert.equal(revisionContext.formalVerificationNode.nodeId, latestPostMutationFormal.nodeId);
    const theoremSpecification = nodes.find((node) => (
      node.kind === 'theorem-spec' && node.dependencies.includes(revision.nodeId)
    ));
    const postRevisionFormal = nodes.find((node) => (
      node.kind === 'formal-verify'
        && node.dependencies.includes(theoremSpecification?.nodeId)
    ));
    assert.ok(theoremSpecification && postRevisionFormal);
    latestPostMutationFormal = postRevisionFormal;
  }

  const sourceClosureFormal = nodes.find((node) => (
    node.kind === 'formal-verify' && node.sourceClosureTerminal === true
  ));
  const finalCompile = nodes.find((node) => node.kind === 'final-compile');
  const researchVerify = nodes.find((node) => node.kind === 'research-verify');
  assert.ok(sourceClosureFormal && finalCompile && researchVerify);
  assert.ok(finalCompile.dependencies.includes(sourceClosureFormal.nodeId));
  assert.equal(deriveCampaignNodeExecutionContext({
    node: finalCompile,
    allNodes: completedNodes,
  }).formalVerificationNode.nodeId, sourceClosureFormal.nodeId);
  assert.equal(deriveCampaignNodeExecutionContext({
    node: researchVerify,
    allNodes: completedNodes,
  }).formalVerificationNode.nodeId, sourceClosureFormal.nodeId);
  for (const formal of nodes.filter((node) => node.kind === 'formal-verify')) {
    assert.ok(researchVerify.dependencies.includes(formal.nodeId), formal.nodeId);
  }
  assert.equal(evaluateCampaignReleaseTopology({ nodes }).status,
    'campaign_release_topology_verified');

  const visited = new Set();
  while (visited.size < nodes.length) {
    const ready = nodes.filter((node) => !visited.has(node.nodeId)
      && node.dependencies.every((dependency) => visited.has(dependency)));
    assert.ok(ready.length > 0, 'full campaign graph must remain acyclic');
    ready.forEach((node) => visited.add(node.nodeId));
  }
});

test('release graph closes formal, empirical replay, and final compile over one immutable terminal source', () => {
  const nodes = buildCampaignModeNodes({
    campaignId: 'campaign-source-closure',
    mode: 'full-campaign',
    rounds: 1,
    reviewers: 2,
    executionProfiles: [{ label: 'python', language: 'python', requiresGpu: false }],
    executionIntent: { kind: 'SourceClosureFixture' },
    empiricalRequested: true,
    applyManuscript: true,
    formalRequested: true,
    researchVerificationRequired: true,
  });
  const sourceClosureFormal = nodes.find((item) => item.kind === 'formal-verify'
    && item.sourceClosureTerminal === true);
  const sourceClosureOriginal = nodes.find((item) => item.kind === 'revalidate-empirical-source-seal');
  const sourceClosureReplay = nodes.find((item) => item.kind === 'revalidate-empirical-reproduce-source-seal');
  const finalCompile = nodes.find((item) => item.kind === 'final-compile');
  const researchVerify = nodes.find((item) => item.kind === 'research-verify');
  assert.ok(sourceClosureFormal && sourceClosureOriginal && sourceClosureReplay);
  assert.deepEqual(sourceClosureOriginal.dependencies, [sourceClosureFormal.nodeId]);
  assert.deepEqual(sourceClosureReplay.dependencies, [sourceClosureOriginal.nodeId]);
  assert.equal(sourceClosureOriginal.sourceMutationPolicy, 'forbid');
  assert.equal(sourceClosureReplay.sourceMutationPolicy, 'forbid');
  assert.equal(finalCompile.sourceMutationPolicy, 'forbid');
  assert.ok(finalCompile.dependencies.includes(sourceClosureFormal.nodeId));
  assert.ok(finalCompile.dependencies.includes(sourceClosureReplay.nodeId));
  assert.ok(researchVerify.dependencies.includes(sourceClosureFormal.nodeId));
  assert.ok(researchVerify.dependencies.includes(sourceClosureReplay.nodeId));
  assert.equal(evaluateCampaignReleaseTopology({ nodes }).status, 'campaign_release_topology_verified');

  const unsealed = structuredClone(nodes);
  const unsealedReplay = unsealed.find((item) => item.kind === sourceClosureReplay.kind);
  delete unsealedReplay.sourceMutationPolicy;
  const blocked = evaluateCampaignReleaseTopology({ nodes: unsealed });
  assert.ok(blocked.blockers.includes(
    `campaign_release_empirical_source_closure_not_sealed:${sourceClosureReplay.nodeId}`,
  ));
});

test('aggregate research prefers the terminal source-closure formal receipt over a higher review round', () => {
  const intermediate = {
    nodeId: 'campaign:1:formal-verify', kind: 'formal-verify', roundIndex: 1,
    status: 'completed', result: { kind: 'CampaignFormalVerificationReceipt', source: 'stale' },
  };
  const terminal = {
    nodeId: 'campaign:0:source-closure-formal-verify', kind: 'formal-verify', roundIndex: 0,
    status: 'completed', sourceClosureTerminal: true,
    spec: { sourceClosureTerminal: true },
    result: { kind: 'CampaignFormalVerificationReceipt', source: 'current' },
  };
  const research = {
    nodeId: 'campaign:research', kind: 'research-verify',
    dependencies: [intermediate.nodeId, terminal.nodeId],
  };
  const context = deriveCampaignNodeExecutionContext({ node: research, allNodes: [intermediate, terminal, research] });
  assert.equal(context.formalVerificationNode.nodeId, terminal.nodeId);
});

test('standalone release and research modes build a current-source theorem-spec and atomic formal candidate chain', () => {
  for (const mode of ['research-verify', 'local-package', 'local-dry-run', 'reviewed-submit']) {
    const value = plan(mode, { paperQualityProfile: 'formal_theorem_or_proof', languages: ['lean', 'latex'] });
    const theoremSpecification = value.nodes.find((item) => item.kind === 'theorem-spec');
    const formalVerify = value.nodes.find((item) => item.kind === 'formal-verify');
    const researchVerify = value.nodes.find((item) => item.kind === 'research-verify');
    assert.ok(theoremSpecification && formalVerify && researchVerify, mode);
    assert.deepEqual(formalVerify.dependencies, [theoremSpecification.nodeId], mode);
    assert.ok(researchVerify.dependencies.includes(formalVerify.nodeId), mode);
    const finalCompile = value.nodes.find((item) => item.kind === 'final-compile');
    if (finalCompile) {
      assert.ok(finalCompile.dependencies.includes(formalVerify.nodeId), mode);
      assert.ok(researchVerify.dependencies.includes(finalCompile.nodeId), mode);
    }
  }
});

test('persistence authority rejects a release whose aggregate research gate omits the latest formal receipt', () => {
  const built = structuredClone(plan('full-campaign', {
    paperQualityProfile: 'formal_theorem_or_proof',
    languages: ['lean', 'latex'],
  }));
  const latestFormalVerify = built.nodes
    .filter((item) => item.kind === 'formal-verify')
    .sort((left, right) => right.roundIndex - left.roundIndex)[0];
  const researchVerify = built.nodes.find((item) => item.kind === 'research-verify');
  researchVerify.dependencies = researchVerify.dependencies.filter((dependency) => dependency !== latestFormalVerify.nodeId);
  delete built.campaignPlanHash;
  built.campaignPlanHash = hashRecord('PaperCampaignPlan', built);
  assert.throws(
    () => assertCampaignDefinition(built),
    /campaign_release_research_formal_verification_dependency_missing/,
  );
});

test('aggregate research selects the latest completed formal receipt after early convergence skips future rounds', () => {
  const formal = (roundIndex, status) => ({
    nodeId: `campaign:formal:${roundIndex}`,
    kind: 'formal-verify',
    roundIndex,
    status,
    result: status === 'completed' ? { kind: 'CampaignFormalVerificationReceipt', roundIndex } : null,
  });
  const completedInitial = formal(0, 'completed');
  const completedRound = formal(1, 'completed');
  const skippedFuture = formal(2, 'skipped');
  const research = {
    nodeId: 'campaign:research',
    kind: 'research-verify',
    dependencies: [completedInitial.nodeId, completedRound.nodeId, skippedFuture.nodeId],
  };
  const context = deriveCampaignNodeExecutionContext({
    node: research,
    allNodes: [completedInitial, completedRound, skippedFuture, research],
  });
  assert.equal(context.formalVerificationNode.nodeId, completedRound.nodeId);
});

test('release-capable full campaign rejects empirical execution without an academic authorized dataset selector', () => {
  assert.throws(() => buildBatchCampaignCommand({
    paperTask: PAPER,
    paperState: { evidenceRefs: [] },
    sourceWorkspace: '/papers/paper-1',
    mode: 'full-campaign',
    targetScopeReceipt: SCOPE,
  }), /campaign_release_empirical_requires_academic_authorized_dataset_selector/);
  assert.throws(
    () => plan('full-campaign', { languages: ['python', 'latex'] }),
    /campaign_release_empirical_requires_academic_authorized_dataset_selector/,
  );
  assert.throws(
    () => plan('full-campaign', { languages: ['python', 'latex'], benchmarkId: 'ml_algorithm_benchmark' }),
    /campaign_release_empirical_requires_academic_authorized_dataset_selector/,
  );
  assert.throws(
    () => plan('full-campaign', {
      languages: ['lean', 'python', 'latex'],
      paperQualityProfile: 'formal_theorem_or_proof',
    }),
    /campaign_release_empirical_requires_academic_authorized_dataset_selector/,
  );

  const value = plan('full-campaign', { languages: ['latex'] });
  const finalCompile = value.nodes.find((item) => item.kind === 'final-compile');
  const researchVerify = value.nodes.find((item) => item.kind === 'research-verify');
  const packageNode = value.nodes.find((item) => item.kind === 'package');

  assert.equal(value.researchVerificationRequired, true);
  assert.equal(value.paperQualityRequirements.researchVerificationRequired, true);
  assert.ok(finalCompile && researchVerify && packageNode);
  assert.equal(value.nodes.some((node) => /^(?:empirical|empirical-reproduce)(?:-|$)/.test(node.kind)), false);
  assert.deepEqual(researchVerify.dependencies, [finalCompile.nodeId]);
  assert.deepEqual(packageNode.dependencies, [finalCompile.nodeId, researchVerify.nodeId]);
});

test('release topology is reconstructed at persistence authority and ignores forged research flags', () => {
  const built = structuredClone(plan('full-campaign', { languages: ['latex'] }));
  assert.equal(assertCampaignDefinition(built), built);

  const withoutResearch = structuredClone(built);
  const researchIds = new Set(withoutResearch.nodes.filter((node) => node.kind === 'research-verify').map((node) => node.nodeId));
  withoutResearch.nodes = withoutResearch.nodes
    .filter((node) => !researchIds.has(node.nodeId))
    .map((node) => ({ ...node, dependencies: node.dependencies.filter((dependency) => !researchIds.has(dependency)) }));
  withoutResearch.researchVerificationRequired = false;
  withoutResearch.paperQualityRequirements.researchVerificationRequired = false;
  withoutResearch.executionIntent.paperQualityRequirements.researchVerificationRequired = false;
  delete withoutResearch.campaignPlanHash;
  withoutResearch.campaignPlanHash = hashRecord('PaperCampaignPlan', withoutResearch);
  assert.throws(() => assertCampaignDefinition(withoutResearch), /campaign_definition_release_topology_invalid/);

  const forgedFlags = structuredClone(built);
  forgedFlags.researchVerificationRequired = false;
  forgedFlags.paperQualityRequirements.researchVerificationRequired = false;
  forgedFlags.executionIntent.paperQualityRequirements.researchVerificationRequired = false;
  delete forgedFlags.campaignPlanHash;
  forgedFlags.campaignPlanHash = hashRecord('PaperCampaignPlan', forgedFlags);
  assert.throws(() => assertCampaignDefinition(forgedFlags), /campaign_definition_release_research_requirement_invalid/);

  const detachedEmpiricalReplay = structuredClone(built);
  detachedEmpiricalReplay.nodes.push(
    { nodeId: 'detached-empirical', kind: 'empirical', roundIndex: 0, dependencies: [], maxAttempts: 1 },
    { nodeId: 'detached-empirical-reproduce', kind: 'empirical-reproduce', roundIndex: 0, dependencies: ['detached-empirical'], maxAttempts: 1 },
  );
  delete detachedEmpiricalReplay.campaignPlanHash;
  detachedEmpiricalReplay.campaignPlanHash = hashRecord('PaperCampaignPlan', detachedEmpiricalReplay);
  assert.throws(
    () => assertCampaignDefinition(detachedEmpiricalReplay),
    /campaign_release_research_empirical_replay_dependency_missing/,
  );
});

test('synthetic builtin benchmark cannot satisfy a composite formal and empirical release profile', () => {
  assert.throws(() => plan('full-campaign', {
    paperQualityProfile: 'theorem_or_proof+empirical_or_experiment',
    languages: ['lean', 'python', 'latex'],
    benchmarkId: 'ml_algorithm_benchmark',
  }), /campaign_release_empirical_requires_academic_authorized_dataset_selector/);
});

test('batch command preserves every paper quality requirement instead of collapsing to the legacy primary profile', () => {
  const paperTask = Object.freeze({
    ...PAPER,
    paperQualityProfile: 'formal_theorem_or_proof',
    paperQualityProfiles: Object.freeze(['formal_theorem_or_proof', 'empirical_or_experiment']),
  });
  const command = buildBatchCampaignCommand({
    paperTask,
    paperState: { evidenceRefs: [] },
    sourceWorkspace: '/papers/paper-1',
    mode: 'empirical-analysis',
    benchmarkId: 'ml_algorithm_benchmark',
    targetScopeReceipt: SCOPE,
  });

  assert.deepEqual(command.paperQualityProfiles, ['formal_theorem_or_proof', 'empirical_or_experiment']);
  assert.deepEqual(command.campaignPlan.paperQualityProfiles, command.paperQualityProfiles);
  assert.equal(command.campaignPlan.paperQualityRequirements.formalVerificationRequired, true);
  assert.equal(command.campaignPlan.paperQualityRequirements.empiricalVerificationRequired, true);
});

test('batch command canonicalizes the theorem alias from its propagated Lean language set', () => {
  const command = buildBatchCampaignCommand({
    paperTask: Object.freeze({
      ...PAPER,
      paperQualityProfile: 'theorem_or_proof',
    }),
    paperState: { evidenceRefs: [] },
    sourceWorkspace: '/papers/paper-1',
    mode: 'full-campaign',
    languages: ['lean', 'latex'],
    targetScopeReceipt: SCOPE,
  });
  const kinds = command.campaignPlan.nodes.map((node) => node.kind);

  assert.deepEqual(command.languages, ['lean', 'latex']);
  assert.deepEqual(command.paperQualityProfiles, ['formal_theorem_or_proof']);
  assert.deepEqual(command.campaignPlan.paperQualityProfiles, command.paperQualityProfiles);
  assert.ok(kinds.includes('theorem-spec'));
  assert.equal(kinds.includes('formal-author'), false);
  assert.equal(kinds.includes('formal-review'), false);
  assert.ok(kinds.includes('formal-verify'));
  assert.equal(kinds.some((kind) => /(?:^|-)empirical-lean(?:-|$)/.test(kind)), false);
});

test('referee-autopilot preserves requested spelling only as command audit metadata', () => {
  const build = (mode) => buildBatchCampaignCommand({
    paperTask: PAPER,
    paperState: { evidenceRefs: [] },
    sourceWorkspace: '/papers/paper-1',
    mode,
    maxRounds: 2,
    targetScopeReceipt: SCOPE,
  });
  const canonical = build('local-review-loop');
  const alias = build('referee-autopilot');

  assert.equal(canonical.requestedMode, 'local-review-loop');
  assert.equal(alias.requestedMode, 'referee-autopilot');
  assert.equal(canonical.effectiveMode, 'local-review-loop');
  assert.equal(alias.effectiveMode, 'local-review-loop');
  assert.equal(alias.campaignId, canonical.campaignId);
  assert.equal(alias.batchCampaignCommandHash, canonical.batchCampaignCommandHash);
  assert.equal(alias.campaignPlanHash, canonical.campaignPlanHash);
  assert.deepEqual(alias.campaignPlan, canonical.campaignPlan);
  assert.equal(alias.campaignPlan.commandBinding.requestedMode, 'local-review-loop');
});

test('modes without a campaign executor fail closed instead of submitting a misleading DAG', () => {
  for (const mode of ['journal-manage', 'venue-resolve', 'source-adapt']) {
    assert.throws(() => plan(mode), new RegExp(`campaign_mode_executor_not_available:${mode}`));
  }
  assert.throws(() => plan('inventory'), /campaign_inventory_mode_has_no_execution_plan/);
  assert.throws(() => plan('unknown'), /campaign_mode_unknown:unknown/);
});

test('batch command binds effective target, builtin benchmark and apply intent into plan and every node spec', () => {
  const command = buildBatchCampaignCommand({
    paperTask: PAPER,
    sourceWorkspace: '/papers/paper-1',
    mode: 'empirical-analysis',
    maxRounds: 9,
    targetScopeReceipt: SCOPE,
    venueTarget: 'Override Venue',
    benchmarkId: 'ml_algorithm_benchmark',
    applyManuscript: true,
  });
  assert.equal(command.requestedDatasetRoot, null);
  assert.equal(command.effectiveDatasetRoot, null);
  assert.equal(command.venueTarget, 'Override Venue');
  assert.equal(command.campaignPlan.venueTarget, 'Override Venue');
  assert.equal(command.campaignPlan.datasetRoot, null);
  assert.deepEqual(command.campaignPlan.datasetMounts, []);
  assert.equal(command.campaignPlan.benchmarkId, 'ml_algorithm_benchmark');
  assert.equal(command.campaignPlan.benchmarkSelector.benchmarkId, 'ml_algorithm_benchmark');
  assert.equal(command.campaignPlan.benchmarkSelector.selectorType, 'builtin_benchmark_suite');
  assert.equal(command.campaignPlan.applyManuscript, true);
  assert.equal(command.campaignPlan.requestedMaxRounds, 9);
  assert.equal(command.campaignPlan.maxRounds, 1);
  assert.deepEqual(command.campaignPlan.nodes.map((node) => node.kind), [
    'research-plan', 'coder', 'empirical', 'empirical-reproduce', 'manuscript-integrate', 'final-compile',
  ]);
  assert.ok(command.campaignPlan.nodes.every((node) => (
    node.executionIntent.venueTarget === 'Override Venue'
    && node.executionIntent.datasetRoot === null
    && node.executionIntent.benchmarkId === 'ml_algorithm_benchmark'
    && node.executionIntent.benchmarkSelectorHash === command.campaignPlan.benchmarkSelector.campaignBenchmarkSelectorHash
    && node.executionIntent.applyManuscript === true
  )));

  const withoutApply = buildBatchCampaignCommand({
    paperTask: PAPER,
    sourceWorkspace: '/papers/paper-1',
    mode: 'empirical-analysis',
    targetScopeReceipt: SCOPE,
  });
  assert.deepEqual(withoutApply.campaignPlan.nodes.map((node) => node.kind), [
    'research-plan', 'coder', 'empirical', 'empirical-reproduce',
  ]);
  assert.notEqual(withoutApply.campaignPlanHash, command.campaignPlanHash);
});

test('empirical-only options are rejected for modes that cannot consume them', () => {
  assert.throws(() => plan('local-build', { benchmarkId: 'unused-benchmark' }), /campaign_empirical_options_not_supported_for_mode:local-build/);
  assert.throws(() => plan('local-build', {
    datasetRoot: '/papers/datasets/unused',
    datasetMounts: [{
      name: 'unused',
      source: '/papers/datasets/unused',
      readOnly: true,
      manifestHash: `sha256:${'b'.repeat(64)}`,
      licenseId: 'CC0-1.0',
    }],
  }), /campaign_empirical_options_not_supported_for_mode:local-build/);
});

test('research verification and benchmark selectors fail closed when their execution contracts are absent or unsupported', () => {
  assert.throws(() => buildPaperCampaignPlan({
    paperId: PAPER.paperId,
    sourceWorkspace: '/papers/paper-1',
    mode: 'research-verify',
  }), /campaign_research_verification_input_required/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: PAPER.paperId,
    sourceWorkspace: '/papers/paper-1',
    mode: 'local-package',
  }), /campaign_research_verification_input_required/);
  assert.throws(() => plan('empirical-analysis', { benchmarkId: 'unknown-without-a-dataset' }), /campaign_benchmark_selector_unsupported/);
  assert.throws(() => plan('empirical-analysis', { benchmarkId: '../unsafe' }), /campaign_benchmark_id_invalid/);
  assert.throws(() => plan('empirical-analysis', {
    benchmarkId: 'operator-dataset',
    datasetMounts: [{
      name: 'operator-dataset',
      source: '/papers/datasets/operator-dataset',
      readOnly: true,
      manifestHash: `sha256:${'a'.repeat(64)}`,
      licenseId: 'CC-BY-4.0',
    }],
  }), /campaign_benchmark_dataset_authorization_invalid:operator-dataset/);
});

test('campaign command replay hash ignores non-consumed and workflow-authority inventory state', () => {
  const command = (mode, paperState) => buildBatchCampaignCommand({
    paperTask: PAPER,
    paperState,
    sourceWorkspace: '/papers/paper-1',
    mode,
    targetScopeReceipt: SCOPE,
  });
  const workflowAuthorityRef = {
    role: 'workflow-authority-receipt',
    ref: 'receipt-ledger/workflow-authority/volatile-entry.json',
    hash: `sha256:${'f'.repeat(64)}`,
  };
  assert.equal(
    command('local-build', { evidenceRefs: [] }).campaignPlanHash,
    command('local-build', { evidenceRefs: [workflowAuthorityRef] }).campaignPlanHash,
  );
  assert.equal(
    command('research-verify', { evidenceRefs: [] }).campaignPlanHash,
    command('research-verify', { evidenceRefs: [workflowAuthorityRef] }).campaignPlanHash,
  );
  assert.notEqual(
    command('research-verify', { evidenceRefs: [] }).campaignPlanHash,
    command('research-verify', { evidenceRefs: [{ role: 'claim-evidence', ref: 'evidence/claim.json', hash: `sha256:${'e'.repeat(64)}` }] }).campaignPlanHash,
  );
});
