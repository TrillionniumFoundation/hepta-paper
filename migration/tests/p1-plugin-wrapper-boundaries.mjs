import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runLatexBuildAdapter,
  runPackageAdapter,
} from '../../paper-adapters/build-package/index.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { runPaperProposalAdapter } from '../../paper-adapters/proposal/index.mjs';
import { runRefereeReviewAdapter } from '../../paper-adapters/referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../../paper-adapters/referee-revise/index.mjs';
import { buildFreshRefereeVerdict } from '../../paper-adapters/journal-manage/index.mjs';
import { buildSubmissionLifecycle } from '../../paper-adapters/submission/index.mjs';
import { runVenueResolveAdapter } from '../../paper-adapters/venue-resolve/index.mjs';
import {
  PAPER_BATCH_MODES,
  runPaperBatch,
} from '../../paper-core/src/paper-batch-runner.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(workspaceRoot, '..');
const runtimeRoot = path.join(workspaceRoot, 'runtime');
const pluginRoot = path.join(root, 'plugins', 'core');

function parseScalar(value) {
  const text = String(value || '').trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === '""') return '';
  if (/^".*"$/.test(text)) return text.slice(1, -1);
  if (/^\[.*\]$/.test(text)) {
    return text.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
  }
  return text;
}

function readPlugin(directory) {
  const text = fs.readFileSync(path.join(pluginRoot, directory, 'plugin.yaml'), 'utf8');
  const descriptor = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (match) descriptor[match[1]] = parseScalar(match[2]);
  }
  return { text, descriptor };
}

function mjsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return mjsFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [absolute] : [];
  });
}

const expected = {
  compile: { id: 'core.compile', type: 'compiler', readOnly: true, external: false },
  'evidence-check': { id: 'core.evidence-check', type: 'evidence', readOnly: false, external: false },
  external: { id: 'core.external', type: 'external', readOnly: false, external: true },
  packager: { id: 'core.packager', type: 'packager', readOnly: false, external: false },
  referee: { id: 'core.referee', type: 'reviewer', readOnly: false, external: false },
  'referee-revision-patch': { id: 'core.referee-revision-patch', type: 'writer', readOnly: false, external: false },
  'referee-revision-planner': { id: 'core.referee-revision-planner', type: 'planner', readOnly: false, external: false },
  report: { id: 'core.report', type: 'reader', readOnly: true, external: false },
  'section-writer': { id: 'core.section-writer', type: 'writer', readOnly: false, external: false },
  'substantive-referee': { id: 'core.substantive-referee', type: 'reviewer', readOnly: false, external: false },
  venue: { id: 'core.venue', type: 'venue', readOnly: true, external: false },
};
for (const [directory, contract] of Object.entries(expected)) {
  const { descriptor } = readPlugin(directory);
  assert.equal(descriptor.id, contract.id);
  assert.equal(descriptor.type, contract.type);
  assert.equal(descriptor.read_only, contract.readOnly);
  assert.equal(descriptor.writes_external_state, contract.external);
}

const retiredRunnerPaths = [
  'plugins/core/referee/run.py',
  'plugins/core/referee-revision-patch/run.py',
  'plugins/core/referee-revision-planner/run.py',
  'plugins/core/substantive-referee/run.py',
];
const productionText = [
  ...mjsFiles(path.join(workspaceRoot, 'paper-core')),
  ...mjsFiles(path.join(workspaceRoot, 'paper-adapters')),
].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
for (const runnerPath of retiredRunnerPaths) {
  assert.ok(fs.existsSync(path.join(root, runnerPath)), runnerPath);
  assert.doesNotMatch(productionText, new RegExp(runnerPath.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')));
}

assert.equal(typeof runLatexBuildAdapter, 'function');
assert.equal(typeof runPackageAdapter, 'function');
assert.equal(typeof runResearchVerifyAdapter, 'function');
assert.equal(typeof runRefereeReviewAdapter, 'function');
assert.equal(typeof runRefereeReviseAdapter, 'function');
assert.equal(typeof buildSubmissionLifecycle, 'function');
assert.equal(typeof runVenueResolveAdapter, 'function');
assert.equal(typeof runPaperBatch, 'function');
assert.equal(typeof runPaperProposalAdapter, 'function');

const task = {
  paperId: 'migration_plugin_fixture',
  taskKey: 'migration_plugin_fixture:paper',
  title: 'Migration plugin fixture',
  paperType: 'systems',
  sourceWorkspace: 'hepta-paper-workspace/migration/fixtures/missing-source',
  mainTex: 'hepta-paper-workspace/migration/fixtures/missing-source/main.tex',
  venueTarget: 'Fixture Venue',
  registry: {},
};
const row = {
  root,
  task,
  state: {
    blockers: ['fixture_not_submit_ready'],
    draftStatus: 'source_missing',
    compileStatus: 'not_built',
    packageStatus: 'package_missing',
  },
  submissionIntent: { status: 'needs_venue_decision' },
};

const build = await runLatexBuildAdapter({
  root,
  row,
  runtimeRoot,
  execute: false,
});
assert.equal(build.safety?.externalActionPerformed, false);

const packageReport = await runPackageAdapter({
  root,
  row,
  buildResult: build,
  runtimeRoot,
  execute: false,
});
assert.equal(packageReport.safety?.externalActionPerformed, false);

const research = await runResearchVerifyAdapter({
  root,
  row,
  runtimeRoot,
});
assert.equal(research.safety?.externalActionPerformed, false);

const lifecycle = buildSubmissionLifecycle({
  row,
  venues: [],
  artifactPackage: null,
  researchReport: research,
  mode: PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  reviewedSubmit: true,
});
assert.equal(lifecycle.safety.externalActionPerformed, false);
assert.equal(lifecycle.safety.dryRunOnly, true);
assert.equal(lifecycle.reviewedSubmitPreflightPacket.status, 'reviewed_submit_preflight_blocked');

const venue = await runVenueResolveAdapter({
  row,
  venues: [],
  packageResult: packageReport,
});
assert.equal(venue.safety.externalActionPerformed, false);
assert.equal(venue.safety.readsOnly, true);

const refereeVerdict = buildFreshRefereeVerdict({
  paperTask: task,
  targetProfile: { status: 'journal_target_profile_ready', profile: { id: 'fixture' } },
  rubricPacket: { status: 'journal_rubric_packet_ready' },
  refereePool: {
    status: 'fresh_referee_pool_ready',
    safety: { academicAcceptanceAuthority: false },
  },
  evidenceGate: { status: 'venue_evidence_gate_ready', blockers: [] },
  lifecyclePolicy: { status: 'venue_lifecycle_policy_ready', blockers: [] },
  reviewReport: { status: 'agent_referee_review_clear', findingCount: 0 },
  packageResult: { artifactPackage: { submitReady: true } },
  lifecycle: {
    reviewedSubmitPreflightPacket: { status: 'reviewed_submit_preflight_ready_for_external_executor' },
    controlledExecutorReceipt: { status: 'controlled_external_executor_receipt_recorded' },
  },
});
assert.equal(refereeVerdict.verdict, 'revise');
assert.ok(refereeVerdict.blockers.includes('independent_referee_review_not_performed'));

const inventory = await runPaperBatch({
  root,
  mode: PAPER_BATCH_MODES.INVENTORY,
  inventorySource: 'hepta',
  limit: 1,
  execute: false,
  writeReport: false,
});
assert.equal(inventory.kind, 'PaperBatchRunReport');
assert.equal(inventory.safety.externalActionPerformed, false);

const proposal = await runPaperProposalAdapter({
  root,
  runtimeRoot,
  idea: 'migration wrapper boundary fixture',
  paperId: 'migration_wrapper_boundary_fixture',
  approved: false,
  materializeSource: false,
  stageInventory: false,
});
assert.equal(proposal.safety.modelCallPerformed, false);
assert.equal(proposal.safety.sourceMutation, false);
assert.equal(proposal.safety.externalActionPerformed, false);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P1PluginWrapperBoundaryTest',
  verifiedPluginDescriptorCount: Object.keys(expected).length,
  retiredPluginRunnerCount: retiredRunnerPaths.length,
  buildExternalAction: build.safety?.externalActionPerformed,
  packageExternalAction: packageReport.safety?.externalActionPerformed,
  researchExternalAction: research.safety?.externalActionPerformed,
  submissionExternalAction: lifecycle.safety.externalActionPerformed,
  venueExternalAction: venue.safety.externalActionPerformed,
  deterministicRefereeAcceptanceAuthority: false,
  reportExternalAction: inventory.safety.externalActionPerformed,
  sectionWriterModelCallRetired: proposal.safety.modelCallPerformed === false,
  sectionWriterSourceMutation: proposal.safety.sourceMutation,
}) + '\n');
