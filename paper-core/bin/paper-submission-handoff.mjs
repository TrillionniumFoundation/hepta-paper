#!/usr/bin/env node
import path from 'node:path';
import { bootstrapSubmissionHandoffContext } from '../../paper-composition/bootstrap/submission-handoff-context-bootstrap.mjs';
import { consumeCampaignReleaseBundleForSubmission } from '../../paper-composition/bootstrap/operator-release-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') {
      options.help = true;
      continue;
    }
    if (!['--campaign-id', '--root', '--runtime-root'].includes(token)) {
      throw new Error(`unsupported submission handoff option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function presentSubmissionInput(input) {
  const authority = input.releaseAuthority;
  return Object.freeze({
    version: input.version,
    kind: input.kind,
    status: input.status,
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    venueTarget: input.venueTarget || null,
    campaignPlanHash: authority.campaignPlanHash,
    packageNodeId: authority.packageNodeId,
    packageAttemptId: authority.packageAttemptId,
    leaseGeneration: authority.leaseGeneration,
    campaignReleaseBundleHash: input.campaignReleaseBundleHash,
    campaignReleasePromotionReceiptHash: input.campaignReleasePromotionReceiptHash,
    submissionCampaignReleaseVerificationReceiptHash: input.submissionCampaignReleaseVerificationReceiptHash,
    campaignReleaseSubmissionInputHash: input.campaignReleaseSubmissionInputHash,
    artifactPackageHash: input.artifactPackageHash,
    packageVerificationReceiptHash: input.packageVerificationReceiptHash,
    manuscriptPromotionGateHash: input.manuscriptPromotionGateHash,
    verificationReceipt: input.verificationReceipt,
    artifactPackage: input.artifactPackage,
    externalActionPerformed: false,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      'Usage: npm run paper:submission-handoff -- --campaign-id <id> [options]',
      '',
      '  --campaign-id <id>    completed campaign release to verify (required)',
      '  --root <path>         independent submission asset root',
      '  --runtime-root <path> shared runtime/store containing the release authority',
      '',
      'This command is read-only. It verifies and emits a typed CampaignReleaseSubmissionInput;',
      'it never dispatches a provider request or performs a live submission.',
      '',
    ].join('\n'));
    return;
  }
  const campaignId = String(options['campaign-id'] || '').trim();
  if (!campaignId) throw new Error('submission_handoff_campaign_id_required');
  const root = path.resolve(options.root || defaultPaperAssetRoot());
  const runtimeRoot = path.resolve(options['runtime-root'] || defaultPaperRuntimeRoot());
  const context = bootstrapSubmissionHandoffContext({
    root,
    runtimeRoot,
  });
  try {
    const input = consumeCampaignReleaseBundleForSubmission({
      releaseAuthorityQuery: context.services.campaignReleaseQuery,
      campaignId,
      expected: { campaignId },
      runtimeRoot,
    });
    process.stdout.write(`${JSON.stringify(presentSubmissionInput(input), null, 2)}\n`);
  } finally {
    context.services.persistenceSession.close?.();
  }
}

main().catch((error) => {
  const payload = {
    version: 1,
    kind: 'CampaignReleaseSubmissionHandoffFailure',
    status: 'campaign_release_submission_handoff_blocked',
    error: String(error?.code || error?.message || 'campaign_release_submission_handoff_failed'),
    blockers: error?.receipt?.blockers || [],
    externalActionPerformed: false,
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
