#!/usr/bin/env node
// Compile the incumbent's immutable journal policy facts once. This producer
// reads exports/AST literals; no journal, provider, database or action executes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as espree from 'espree';
import * as keys from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt-keys.data.mjs';
import { AUTONOMOUS_RESEARCH_ONE_SHOT_HISTORICAL_ATTEMPT_ANCHORS as anchors } from '../../paper-domain/automation/autonomous-research-one-shot-historical-attempt-anchors.data.mjs';
import * as schema from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs';
import * as target from '../../paper-domain/automation/autonomous-research-one-shot-target-campaign.mjs';
import * as binding from '../../paper-domain/automation/autonomous-research-one-shot-campaign-execution-binding.mjs';
import { AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS as options } from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import { usage } from '../../paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inputs = [
  'paper-domain/automation/autonomous-research-one-shot-campaign-attempt-keys.data.mjs',
  'paper-domain/automation/autonomous-research-one-shot-historical-attempt-anchors.data.mjs',
  'paper-domain/automation/autonomous-research-one-shot-target-campaign.mjs',
  'paper-domain/automation/autonomous-research-one-shot-campaign-execution-binding.mjs',
  'paper-domain/automation/autonomous-research-one-shot-provider-runtime-binding.mjs',
  'paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs',
  'paper-domain/automation/autonomous-research-one-shot-canonical-json.mjs',
  'paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs',
  'paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs',
  'paper-adapters/automation/campaign-one-shot-attempt-journal-support.mjs',
  'paper-adapters/automation/campaign-one-shot-attempt-journal-inspection.mjs',
  'paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs',
  'workflow-kernel/record-hash.mjs',
];
const ast = espree.parse(fs.readFileSync(path.join(root, inputs[2]), 'utf8'), { ecmaVersion: 2025, sourceType: 'module' });
const declaration = ast.body.filter((node) => node.type === 'VariableDeclaration')
  .flatMap((node) => node.declarations).find((node) => node.id.name === 'ISSUED_HISTORICAL_TARGET_DEFINITION_HASHES');
if (declaration?.init?.type !== 'NewExpression' || declaration.init.callee.name !== 'Map'
  || declaration.init.arguments.length !== 1 || declaration.init.arguments[0].type !== 'ArrayExpression') {
  throw new Error('one_shot_historical_target_contract_shape_invalid');
}
const historicalTargets = Object.fromEntries(declaration.init.arguments[0].elements.map((entry) => {
  if (entry?.type !== 'ArrayExpression' || entry.elements.length !== 2
    || entry.elements.some((item) => item?.type !== 'Literal' || typeof item.value !== 'string')) {
    throw new Error('one_shot_historical_target_contract_shape_invalid');
  }
  return entry.elements.map((item) => item.value);
}));
const expectedTarget = {
  version: 1, campaignId: options.campaignId, paperId: options.paperId,
  objective: options.objective, protocolFamily: options.protocolFamily,
  revisionRounds: options.revisionRounds, refereeCount: options.refereeCount,
  requestedLaunchMode: options.requestedLaunchMode, effectiveLaunchMode: options.launchMode,
  localOnly: options.localOnly, humanSubjects: options.humanSubjects, privateData: options.privateData,
  unlimitedAggregateTokens: true, unlimitedAggregateCost: true,
  requireLaunchReady: options.requireLaunchReady,
  requireCampaignAbsentAtLaunch: options.requireCampaignAbsentAtLaunch,
  datasetMountsHash: target.AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH,
  worker: options.worker, budgets: options.budgets,
};
if (!target.verifyAutonomousResearchOneShotTargetCampaignDefinition(expectedTarget)) {
  throw new Error('one_shot_current_target_contract_invalid');
}
const contract = {
  version: 1, kind: 'NativeOneShotHistoricalStatusContract',
  reservationKeys: keys.AUTONOMOUS_RESEARCH_ONE_SHOT_RESERVATION_KEYS,
  eventKeys: keys.AUTONOMOUS_RESEARCH_ONE_SHOT_EVENT_KEYS,
  receiptKeys: keys.AUTONOMOUS_RESEARCH_ONE_SHOT_RECEIPT_KEYS,
  schemaObjects: schema.CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_EXPECTED_SCHEMA_OBJECTS,
  schemaContractId: schema.CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID,
  schemaContractHash: schema.CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH,
  historicalAnchors: anchors, historicalTargets,
  currentTarget: expectedTarget,
  currentTargetHash: hashRecord('AutonomousResearchOneShotTargetCampaignDefinition', expectedTarget),
  protectedCampaignId: binding.AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  providerConfigurationHash: binding.AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  forbiddenEnvironmentKeys: binding.AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
  usage: usage(),
  sourceHashes: Object.fromEntries(inputs.map((relative) => [relative,
    createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')])),
};
process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
