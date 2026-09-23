import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { JOURNAL_PROFILES } from '../../paper-domain/journal/journal-registry.mjs';
import {
  JOURNAL_SUBMISSION_CONNECTOR_COVERAGE,
  buildJournalConnectorCoverage,
} from '../../paper-domain/submission/journal-connector-coverage.mjs';

test('every hepta journal profile has one explicit connector disposition', () => {
  const coverage = JOURNAL_SUBMISSION_CONNECTOR_COVERAGE;
  assert.equal(coverage.version, 2);
  assert.equal(coverage.entries.every((entry) => entry.version === 2), true);
  assert.equal(coverage.journalProfileCount, JOURNAL_PROFILES.length);
  assert.equal(coverage.dispositionCount, JOURNAL_PROFILES.length);
  assert.equal(coverage.connectorFamilyPrototypeAvailableCount, 98);
  assert.equal(coverage.journalConnectorFamilyPrototypeAvailableCount, 60);
  assert.equal(coverage.journalProfileCount, 98);
  assert.equal(new Set(coverage.entries.map((entry) => entry.venueId)).size, 98);
  assert.deepEqual(
    coverage.entries.map((entry) => entry.venueId).sort(),
    JOURNAL_PROFILES.map((profile) => profile.id).sort(),
  );
  assert.equal(coverage.silentFallbackPermitted, false);
  assert.equal(coverage.identityKnownCount, 98);
  assert.equal(coverage.targetProfileResolvedCount, 0);
  assert.equal(coverage.prototypeAdapterPresentCount, 4);
  assert.equal(coverage.adapterImplementedCount, 4);
  assert.equal(coverage.sandboxQualifiedCount, 0);
  assert.equal(coverage.productionQualifiedCount, 0);
  assert.equal(coverage.liveCommitAuthorizedCount, 0);
  assert.equal(coverage.liveSubmissionReadyCount, 0);
  assert.equal(coverage.discoveryRequiredCount, 98);
});

test('OpenReview prototypes and all discovery seeds remain fail closed', () => {
  const coverage = buildJournalConnectorCoverage();
  for (const venueId of ['iclr', 'icml', 'neurips', 'tmlr']) {
    const entry = coverage.entries.find((candidate) => candidate.venueId === venueId);
    assert.equal(entry.connectorFamily, 'openreview-api-v2');
    assert.equal(entry.prototypeAdapterPresent, true);
    assert.equal(entry.implementationReady, true);
    assert.equal(entry.targetProfileResolved, false);
    assert.equal(entry.productionQualified, false);
    assert.equal(entry.discoveryRequired, true);
  }
  const nature = coverage.entries.find((entry) => entry.venueId === 'nature');
  assert.equal(nature.connectorFamily, 'portal-schema-discovery-required-v1');
  assert.equal(nature.discoveryRequired, true);
  assert.equal(nature.implementationReady, false);
  assert.ok(nature.candidateConnectorFamilies.includes('playwright-assisted-draft-v1'));
  assert.ok(nature.blockers.includes('submission_portal_binding_evidence_required'));

  const theoryTargets = coverage.entries.filter((entry) => (
    ['alt', 'colt'].includes(entry.venueId)
  ));
  assert.equal(theoryTargets.length, 2);
  assert.notEqual(
    theoryTargets[0].journalSubmissionConnectorCoverageEntryHash,
    theoryTargets[1].journalSubmissionConnectorCoverageEntryHash,
  );
  assert.equal(
    coverage.entries.some((entry) => entry.venueId === 'colt_alt'),
    false,
  );
  for (const target of theoryTargets) {
    assert.equal(target.identityKnown, true);
    assert.equal(
      target.connectorDisposition,
      'connector_family_prototype_present_target_profile_required',
    );
    assert.equal(target.connectorFamilyPrototypeAvailable, true);
    assert.equal(target.blockers.includes('venue_identity_split_required'), false);
    assert.ok(target.blockers.includes('submission_target_adapter_profile_required'));
  }
});

test('coverage CLI proves all 60 journal targets have a candidate family prototype', () => {
  const result = spawnSync(process.execPath, [
    'paper-core/bin/journal-connector-coverage.mjs',
    '--summary',
    '--kind',
    'journal',
    '--require-family-prototype',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.selectedVenueCount, 60);
  assert.equal(report.journalConnectorFamilyPrototypeAvailableCount, 60);

  const allTargets = spawnSync(process.execPath, [
    'paper-core/bin/journal-connector-coverage.mjs',
    '--summary',
    '--require-family-prototype',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(allTargets.status, 0, allTargets.stderr);

  const retiredComposite = spawnSync(process.execPath, [
    'paper-core/bin/journal-connector-coverage.mjs',
    '--summary',
    '--venue',
    'colt_alt',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(retiredComposite.status, 1);
  assert.match(
    retiredComposite.stderr,
    /journal_submission_connector_coverage_unknown_venue:colt_alt/,
  );
});
