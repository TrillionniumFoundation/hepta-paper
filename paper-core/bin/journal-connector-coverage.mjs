#!/usr/bin/env node
import {
  JOURNAL_SUBMISSION_CONNECTOR_COVERAGE,
} from '../../paper-domain/submission/journal-connector-coverage.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: [
    'help',
    'summary',
    'require-family-prototype',
    'require-profile-resolved',
    'require-adapter-implemented',
    'require-sandbox-qualified',
    'require-production-qualified',
    'require-live-ready',
  ],
  valueFlags: ['kind', 'venue'],
  positional: false,
});
if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 2,
    kind: 'JournalConnectorCoverageUsage',
    usage: [
      'journal-connector-coverage [--summary] [--kind journal|conference]',
      '[--venue <venue-id>] [--require-family-prototype]',
      '[--require-profile-resolved] [--require-adapter-implemented]',
      '[--require-sandbox-qualified] [--require-production-qualified]',
      '[--require-live-ready]',
    ].join(' '),
    mutation: 'read-only',
    externalAction: false,
  }, null, 2)}\n`);
  process.exit(0);
}
if (args.kind && !['conference', 'journal'].includes(args.kind)) {
  throw new Error(`journal_submission_connector_coverage_kind_invalid:${args.kind}`);
}
const venueEntries = args.venue
  ? JOURNAL_SUBMISSION_CONNECTOR_COVERAGE.entries.filter((entry) => (
    entry.venueId === args.venue
  ))
  : JOURNAL_SUBMISSION_CONNECTOR_COVERAGE.entries;
if (args.venue && venueEntries.length !== 1) {
  throw new Error(`journal_submission_connector_coverage_unknown_venue:${args.venue}`);
}
const selectedEntries = args.kind
  ? venueEntries.filter((entry) => entry.venueKind === args.kind)
  : venueEntries;
if (args.venue && args.kind && selectedEntries.length !== 1) {
  throw new Error(
    `journal_submission_connector_coverage_venue_kind_mismatch:${args.venue}:${args.kind}`,
  );
}
const summary = {
  version: 2,
  kind: 'JournalConnectorCoverageSummary',
  selectedVenueCount: selectedEntries.length,
  identityKnownCount: selectedEntries.filter((entry) => entry.identityKnown).length,
  targetProfileResolvedCount:
    selectedEntries.filter((entry) => entry.targetProfileResolved).length,
  connectorFamilyPrototypeAvailableCount:
    selectedEntries.filter((entry) => (
      entry.connectorFamilyPrototypeAvailable
    )).length,
  journalConnectorFamilyPrototypeAvailableCount:
    selectedEntries.filter((entry) => (
      entry.venueKind === 'journal'
        && entry.connectorFamilyPrototypeAvailable
    )).length,
  prototypeAdapterPresentCount:
    selectedEntries.filter((entry) => entry.prototypeAdapterPresent).length,
  adapterImplementedCount:
    selectedEntries.filter((entry) => entry.adapterImplemented).length,
  sandboxQualifiedCount:
    selectedEntries.filter((entry) => entry.sandboxQualified).length,
  productionQualifiedCount:
    selectedEntries.filter((entry) => entry.productionQualified).length,
  liveCommitAuthorizedCount:
    selectedEntries.filter((entry) => entry.liveCommitAuthorized).length,
  liveSubmissionReadyCount:
    selectedEntries.filter((entry) => entry.liveSubmissionReady).length,
  discoveryRequiredCount:
    selectedEntries.filter((entry) => entry.discoveryRequired).length,
  entries: args.summary ? undefined : selectedEntries,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
const gates = [
  ['require-family-prototype', 'connectorFamilyPrototypeAvailable'],
  ['require-profile-resolved', 'targetProfileResolved'],
  ['require-adapter-implemented', 'adapterImplemented'],
  ['require-sandbox-qualified', 'sandboxQualified'],
  ['require-production-qualified', 'productionQualified'],
  ['require-live-ready', 'liveSubmissionReady'],
];
if (gates.some(([flag, field]) => (
  args[flag] === true && selectedEntries.some((entry) => entry[field] !== true)
))) {
  process.exitCode = 1;
}
