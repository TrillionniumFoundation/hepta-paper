import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  bindEmpiricalAssertionUniverse,
  buildEmpiricalAssertionAuthority,
  buildEmpiricalPresentationAuthority,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import {
  readEmpiricalAssertionUniverse,
} from '../../paper-adapters/research-verify/empirical-assertion-universe-reader.mjs';
import {
  empiricalAssertionAuthorityEntriesMatch,
} from '../../paper-adapters/automation/empirical-assertion-authority.mjs';
import { runManuscriptQualityChecks } from '../../paper-adapters/automation/manuscript-quality-checks.mjs';
import {
  empiricalAssertionResearchReportValid,
} from '../../paper-adapters/build-package/research-evidence-empirical-assertion-binding.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  authority,
  block,
  body,
  experiment,
  hash,
  presentationBlock,
  projectedRegistryFixture,
  readAndBind,
  workspace,
  writePresentationArtifacts,
} from './support/empirical-assertion-contract-fixture.mjs';

test('typed empirical assertion happy path binds both positive and negative replay results', () => {
  const trusted = authority();
  const root = workspace(`\\section{Results}\n${trusted.entries.map((entry) => block(entry)).join('\n')}`);
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_verified', universe.blockers.join('\n'));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_verified');
  assert.equal(binding.bindings.length, 2);
  assert.deepEqual(binding.bindings.map((item) => item.scientificVerdict).sort(), ['negative', 'positive']);
  assert.deepEqual(binding.bindings.map((item) => item.verdict).sort(), ['negative', 'positive']);
  for (const entry of trusted.entries) {
    assert.equal(entry.predicate.metricUnit, 'score-points');
    assert.equal(entry.predicate.pairedUnit, 'seed');
    assert.equal(entry.replay.artifactPath, `automation-results/${entry.replay.artifactPath.split('/')[1]}/results.json`);
  }
});

test('empirical assertion units come from the signed protocol and must match replay', () => {
  const trustedExperiment = structuredClone(experiment({
    suffix: 'unit-bound', claimId: 'claim-unit', hypothesisId: 'hyp-unit',
    accepted: true, estimate: 0.5,
  }));
  trustedExperiment.replayEvaluation.analysisProtocol.metricSpecs.score.unit = 'ratio';
  assert.throws(() => buildEmpiricalAssertionAuthority({
    paperId: 'paper-unit',
    campaignId: 'campaign-unit',
    experimentRegistryHash: hash('d'),
    experiments: [trustedExperiment],
  }), /empirical_assertion_replay_verdict_mismatch/);
});

test('inconclusive scientific verdict and uncertainty reasons remain distinct from a negative result', () => {
  const uncertaintyReasons = ['analysis_independent_unit_count_insufficient'];
  const trusted = buildEmpiricalAssertionAuthority({
    paperId: 'paper-inconclusive',
    campaignId: 'campaign-inconclusive',
    experimentRegistryHash: hash('d'),
    experiments: [experiment({
      suffix: 'inconclusive',
      claimId: 'claim-inconclusive',
      hypothesisId: 'hyp-inconclusive',
      accepted: false,
      estimate: 0.05,
      scientificVerdict: 'inconclusive',
      scientificUncertaintyReasons: uncertaintyReasons,
    })],
  });
  const [entry] = trusted.entries;
  assert.equal(entry.scientificVerdict, 'inconclusive');
  assert.equal(entry.verdict, 'inconclusive');
  assert.deepEqual(entry.original.result.scientificUncertaintyReasons, uncertaintyReasons);
  assert.deepEqual(entry.replay.result.scientificUncertaintyReasons, uncertaintyReasons);
  assert.match(entry.canonicalManuscriptBody, /scientificVerdict inconclusive/);
  assert.match(entry.canonicalManuscriptBody, /registry-bound scientific verdict is inconclusive/);
  assert.ok(entry.canonicalManuscriptBody.includes(Buffer.from(uncertaintyReasons[0]).toString('hex')));
  const negative = authority().entries.find((candidate) => candidate.scientificVerdict === 'negative');
  assert.notEqual(entry.canonicalManuscriptBodyHash, negative.canonicalManuscriptBodyHash);

  const root = workspace(`\\section{Results}\n${block(entry)}`);
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_verified', universe.blockers.join('\n'));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_verified');
  assert.equal(binding.bindings[0].scientificVerdict, 'inconclusive');
  assert.equal(binding.bindings[0].verdict, 'inconclusive');
});

test('typed tables, figures, and captions bind deterministic bytes to every claim and experiment lineage', () => {
  const trusted = authority();
  const presentationAuthority = buildEmpiricalPresentationAuthority(trusted);
  const root = workspace([
    '\\section{Results}',
    ...trusted.entries.map((entry) => block(entry)),
    ...presentationAuthority.entries.map((entry) => presentationBlock(entry)),
  ].join('\n'));
  writePresentationArtifacts(root, trusted);
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_verified', universe.blockers.join('\n'));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_verified', binding.blockers.join('\n'));
  assert.equal(binding.empiricalPresentationAuthorityHash,
    presentationAuthority.empiricalPresentationAuthorityHash);
  assert.equal(binding.presentationBindings.length, 2);
  assert.deepEqual(
    binding.presentationBindings.map((item) => item.surfaceKind).sort(),
    ['confirmatory_result_figure', 'confirmatory_result_table'],
  );
  for (const item of binding.presentationBindings) {
    assert.deepEqual(item.claimIds, trusted.entries.map((entry) => entry.claimId));
    assert.deepEqual(item.experimentIds, trusted.entries.map((entry) => entry.experimentId));
    assert.deepEqual(item.authorityEntryHashes,
      trusted.entries.map((entry) => entry.empiricalAssertionAuthorityEntryHash));
  }
  const [artifact] = presentationAuthority.artifacts;
  assert.equal(universe.presentationArtifacts[0].path, artifact.path);
  assert.equal(universe.presentationArtifacts[0].hash, artifact.hash);
  assert.equal(hashBytes(fs.readFileSync(path.join(root, artifact.path))), artifact.hash);
  const source = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  assert.match(source, /\\begin\{table\}/);
  assert.match(source, /\\begin\{figure\}/);
  assert.match(source, /\\caption\{Registry-bound/);
});

test('typed presentation rejects self-minted markers, caption edits, omitted surfaces, and artifact substitution', () => {
  const trusted = authority();
  const presentationAuthority = buildEmpiricalPresentationAuthority(trusted);
  const assertionSource = trusted.entries.map((entry) => block(entry)).join('\n');
  const canonicalSource = presentationAuthority.entries.map((entry) => presentationBlock(entry)).join('\n');

  const captionRoot = workspace(`\\section{Results}\n${assertionSource}\n${canonicalSource.replace('Registry-bound confirmatory results', 'Agent-authored favorable results')}`);
  writePresentationArtifacts(captionRoot, trusted);
  const captionBinding = readAndBind(captionRoot, trusted).binding;
  assert.equal(captionBinding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(captionBinding.blockers.some((item) => item.startsWith('empirical_presentation_canonical_body_mismatch:')));

  const omittedRoot = workspace(`\\section{Results}\n${assertionSource}\n${presentationBlock(presentationAuthority.entries[0])}`);
  const omittedBinding = readAndBind(omittedRoot, trusted).binding;
  assert.equal(omittedBinding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(omittedBinding.blockers.some((item) => item.startsWith('empirical_presentation_authority_entry_unreported:')));

  const forgedDeclaration = {
    version: 1,
    surfaceId: 'agent-forged-table',
    surfaceKind: 'confirmatory_result_table',
    surfaceAuthorityEntryHash: hash('f'),
    artifactPath: null,
    artifactHash: null,
  };
  const forgedRoot = workspace([
    '\\section{Results}',
    assertionSource,
    `% HEPTA_EMPIRICAL_PRESENTATION_BEGIN ${JSON.stringify(forgedDeclaration)}`,
    '\\begin{table}\\caption{Our method wins.}\\end{table}',
    `% HEPTA_EMPIRICAL_PRESENTATION_END ${forgedDeclaration.surfaceId}`,
  ].join('\n'));
  const forged = readAndBind(forgedRoot, trusted);
  assert.equal(forged.universe.status, 'empirical_assertion_universe_verified', forged.universe.blockers.join('\n'));
  assert.equal(forged.binding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(forged.binding.blockers.some((item) => item.startsWith('empirical_presentation_authority_reference_invalid:')));

  const artifactRoot = workspace(`\\section{Results}\n${assertionSource}\n${canonicalSource}`);
  writePresentationArtifacts(artifactRoot, trusted);
  const [artifact] = presentationAuthority.artifacts;
  fs.appendFileSync(path.join(artifactRoot, artifact.path), '\nforged');
  const substituted = readAndBind(artifactRoot, trusted);
  assert.equal(substituted.universe.status, 'empirical_assertion_universe_blocked');
  assert.ok(substituted.universe.blockers.some((item) => item.startsWith('empirical_presentation_artifact_hash_mismatch:')));
  assert.equal(substituted.binding.status, 'empirical_assertion_universe_binding_blocked');
});

test('scientific claims cannot be smuggled through title metadata', () => {
  const trusted = authority();
  const root = workspace([
    '\\title{Our method is universally superior}',
    '\\section{Results}',
    ...trusted.entries.map((entry) => block(entry)),
  ].join('\n'));
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_blocked');
  assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_untyped_result_prose:')));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
});

for (const sentence of [
  'Our approach performs better than all controls in practice.',
  'The proposed method consistently wins against the reference system.',
  'These findings establish the practical superiority of our approach.',
]) {
  test(`untyped Results prose fails closed without keyword classification: ${sentence}`, () => {
    const root = workspace(`\\section{Results}\n${sentence}`);
    const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
    assert.equal(universe.status, 'empirical_assertion_universe_blocked');
    assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_untyped_result_prose:')));
  });
}

test('self-minted or changed claim, path, value, and verdict authorities never match registry-derived authority', () => {
  const trusted = authority();
  for (const mutate of [
    (entry) => { entry.claimId = 'claim-substituted'; },
    (entry) => { entry.original.artifactPath = 'automation-results/attacker/results.json'; },
    (entry) => { entry.original.result.estimate = 99; },
    (entry) => { entry.verdict = entry.verdict === 'positive' ? 'negative' : 'positive'; },
  ]) {
    const forged = structuredClone(trusted);
    const entryPayload = { ...forged.entries[0] };
    delete entryPayload.empiricalAssertionAuthorityEntryHash;
    mutate(entryPayload);
    forged.entries[0] = {
      ...entryPayload,
      empiricalAssertionAuthorityEntryHash: hashRecord('EmpiricalAssertionAuthorityEntry', entryPayload),
    };
    const authorityPayload = { ...forged };
    delete authorityPayload.empiricalAssertionAuthorityHash;
    forged.empiricalAssertionAuthorityHash = hashRecord('EmpiricalAssertionAuthority', authorityPayload);
    assert.equal(empiricalAssertionAuthorityEntriesMatch(forged, trusted), false);
  }
});

test('capsule validation rebuilds from the registry projection and rejects a fully rehashed entry', () => {
  const fixture = projectedRegistryFixture();
  const root = workspace(`\\section{Results}\n${fixture.trustedAuthority.entries.map((entry) => block(entry)).join('\n')}`);
  const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  const binding = bindEmpiricalAssertionUniverse({
    authority: fixture.trustedAuthority,
    universe,
    expectedPaperId: fixture.paperId,
    expectedCampaignId: fixture.campaignId,
    expectedExperimentRegistryHash: fixture.registry.experimentRegistryHash,
  });
  const report = {
    paperId: fixture.paperId,
    empiricalAssertionAuthorityHash: fixture.trustedAuthority.empiricalAssertionAuthorityHash,
    empiricalAssertionUniverseHash: universe.empiricalAssertionUniverseHash,
    empiricalAssertionUniverseBindingHash: binding.empiricalAssertionUniverseBindingHash,
    empiricalAssertionManuscriptCorpusHash: universe.manuscriptCorpusHash,
    capabilities: {
      experimentRegistry: fixture.registry,
      empiricalAssertionAuthority: fixture.trustedAuthority,
      empiricalAssertionUniverse: universe,
      empiricalAssertionUniverseBinding: binding,
    },
  };
  assert.equal(empiricalAssertionResearchReportValid(report, {
    campaignId: fixture.campaignId,
    registry: fixture.registry,
    derivationEvidence: fixture.derivationEvidence,
  }), true);

  const forgedReport = structuredClone(report);
  const entryPayload = { ...forgedReport.capabilities.empiricalAssertionAuthority.entries[0] };
  delete entryPayload.empiricalAssertionAuthorityEntryHash;
  entryPayload.original.result.estimate = 99;
  const forgedEntry = {
    ...entryPayload,
    empiricalAssertionAuthorityEntryHash: hashRecord('EmpiricalAssertionAuthorityEntry', entryPayload),
  };
  forgedReport.capabilities.empiricalAssertionAuthority.entries[0] = forgedEntry;
  const authorityPayload = { ...forgedReport.capabilities.empiricalAssertionAuthority };
  delete authorityPayload.empiricalAssertionAuthorityHash;
  forgedReport.capabilities.empiricalAssertionAuthority.empiricalAssertionAuthorityHash =
    hashRecord('EmpiricalAssertionAuthority', authorityPayload);
  forgedReport.empiricalAssertionAuthorityHash =
    forgedReport.capabilities.empiricalAssertionAuthority.empiricalAssertionAuthorityHash;
  assert.equal(empiricalAssertionResearchReportValid(forgedReport, {
    campaignId: fixture.campaignId,
    registry: fixture.registry,
    derivationEvidence: fixture.derivationEvidence,
  }), false);
});

test('swapping an assertion id or authority entry hash cannot bind to another claim', () => {
  const trusted = authority();
  const [left, right] = trusted.entries;
  const declaration = {
    version: 1,
    assertionId: left.assertionId,
    authorityEntryHash: right.empiricalAssertionAuthorityEntryHash,
  };
  const root = workspace(`\\section{Results}\n% HEPTA_EMPIRICAL_ASSERTION_BEGIN ${JSON.stringify(declaration)}\n${body(left)}\n% HEPTA_EMPIRICAL_ASSERTION_END ${left.assertionId}\n${block(right)}`);
  const { binding } = readAndBind(root, trusted);
  assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(binding.blockers.some((item) => item.startsWith('empirical_assertion_authority_reference_invalid:')));
});

test('body verdict, numeric value, hypothesis, metric, comparator, and original/replay tampering fails deterministically', () => {
  const trusted = authority();
  const target = trusted.entries.find((entry) => entry.verdict === 'positive');
  const other = trusted.entries.find((entry) => entry !== target);
  const bodies = [
    body(target).replace('scientificVerdict positive', 'scientificVerdict negative'),
    body(target).replace('estimate 0.5', 'estimate 99'),
    body(target).replace(Buffer.from(target.hypothesisId).toString('hex'), Buffer.from('hyp-substituted').toString('hex')),
    body(target).replace(Buffer.from(target.predicate.metric).toString('hex'), Buffer.from('wrong-metric').toString('hex')),
    body(target).replace(target.predicate.comparator, 'ablation'),
    body(target).replace('Isolated deterministic rerun', 'Second execution'),
  ];
  for (const text of bodies) {
    const root = workspace(`\\section{Results}\n${block(target, text)}\n${block(other)}`);
    const { binding } = readAndBind(root, trusted);
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
  }
});

test('section aliases cannot disable strict typed empirical prose enforcement', () => {
  const trusted = authority();
  for (const title of ['Empirical Results', 'Main Results']) {
    const source = `\\section{${title}}\n${trusted.entries.map((entry) => block(entry)).join('\n')}\nThis establishes universal superiority in every setting.`;
    const root = workspace(source);
    const { universe, binding } = readAndBind(root, trusted);
    assert.equal(universe.status, 'empirical_assertion_universe_blocked');
    assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_untyped_result_prose:')));
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
  }
});

test('canonical body rejects appended prose and TeX conditional rendering attacks', () => {
  const trusted = authority();
  const [target, other] = trusted.entries;
  for (const text of [
    `${body(target)} This establishes universal superiority in every setting.`,
    `\\iffalse\n${body(target)}\n\\fi\nThis establishes universal superiority in every setting.`,
  ]) {
    const root = workspace(`\\section{Results}\n${block(target, text)}\n${block(other)}`);
    const { binding } = readAndBind(root, trusted);
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
    assert.ok(binding.blockers.includes(`empirical_assertion_canonical_body_mismatch:${target.assertionId}`));
  }
});

test('body-byte mutation changes the bound corpus and cannot reuse a prior research-report universe', () => {
  const trusted = authority();
  const originalRoot = workspace(`\\section{Results}\n${trusted.entries.map((entry) => block(entry)).join('\n')}`);
  const changedRoot = workspace(`\\section{Results}\n${trusted.entries.map((entry, index) => block(entry, `${body(entry)}${index ? '' : ' Extra bounded wording.'}`)).join('\n')}`);
  const original = readEmpiricalAssertionUniverse({ sourceRoot: originalRoot, manuscriptPath: 'main.tex' });
  const changed = readEmpiricalAssertionUniverse({ sourceRoot: changedRoot, manuscriptPath: 'main.tex' });
  assert.notEqual(changed.manuscriptCorpusHash, original.manuscriptCorpusHash);
  assert.notEqual(changed.empiricalAssertionUniverseHash, original.empiricalAssertionUniverseHash);
});

test('legacy HEPTA_RESULT is rejected by typed parsing and trusted promotion checks', () => {
  const root = workspace('\\section{Results}\n% HEPTA_RESULT CLAIM claim-positive automation-results/x/results.json#score=0.5\nLegacy prose.');
  const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.ok(universe.blockers.some((item) => item.startsWith('legacy_empirical_result_marker_forbidden:')));
  const receipt = runManuscriptQualityChecks({
    workspacePath: root,
    manuscriptPath: 'main.tex',
    mode: 'artifacts',
    requiresTrustedEmpiricalAuthority: true,
  });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes('legacy_empirical_result_marker_forbidden'));
});

test('result titles, captions, tables, and figures remain fail-closed surfaces', () => {
  for (const surface of [
    '\\subsection{A favorable result}',
    '\\caption{A result}',
    '\\begin{table}',
    '\\begin{figure}',
  ]) {
    const root = workspace(`\\section{Results}\n${surface}`);
    const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
    assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_unsupported_result_surface:')));
  }
});

test('equation, bibliography, theorem, proof, package, and local render-support injection fail closed', () => {
  const trusted = authority();
  const canonical = trusted.entries.map((entry) => block(entry)).join('\n');
  for (const injected of [
    '\\begin{equation}\n\\text{Our method always defeats every baseline.}\n\\end{equation}',
    '\\begin{thebibliography}{1}\nOur method always defeats every baseline.\n\\end{thebibliography}',
    '\\begin{theorem}\nOur method always defeats every baseline.\n\\end{theorem}',
    '\\begin{proof}\nOur method always defeats every baseline.\n\\end{proof}',
    '\\usepackage{attacker}',
  ]) {
    const root = workspace(`\\section{Results}\n${canonical}\n${injected}`);
    const { universe, binding } = readAndBind(root, trusted);
    assert.equal(universe.status, 'empirical_assertion_universe_blocked', injected);
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked', injected);
  }
  const root = workspace(`\\section{Results}\n${canonical}`);
  fs.writeFileSync(path.join(root, 'amsmath.sty'), '\\ProvidesPackage{amsmath} Our method always wins.');
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_blocked');
  assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_render_support_file_forbidden:')));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
});
