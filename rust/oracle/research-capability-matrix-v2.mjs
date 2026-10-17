// Test-only Node incumbent oracle: pure reporting, no runtime observation or I/O authorities.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildResearchCapabilityMatrix } from '../../paper-application/automation/research-capability-matrix.mjs';
import { AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES as profiles, AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES as languages } from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import { AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY as formal } from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { FORMAL_PROOF_SEARCH_BACKENDS as backends, FORMAL_PROOF_SEARCH_STRATEGIES as strategies } from '../../paper-domain/research/formal-proof-strategy-registry.mjs';
assert.equal(process.version, 'v22.23.1');
const source = JSON.parse(fs.readFileSync(new URL('../crates/hepta-paper-service/src/research_capability_matrix/registry-inputs.v1.json', import.meta.url)));
assert.deepEqual(source.profiles, profiles.map(({ benchmarkFamily, typedOracleKinds }) => ({ benchmarkFamily, typedOracleKinds })));
assert.deepEqual(source.languages, languages);
assert.deepEqual(source.formalTemplateIds, formal.entries.map(entry => entry.templateId));
assert.deepEqual(source.backends, backends.map(({ backend, availability, executionMode, productionQualification }) => ({ backend, availability, executionMode, productionQualification })));
assert.deepEqual(source.strategies, strategies.map(({ strategy, capabilities }) => ({ strategy, capabilities })));
for (const [file, hash] of Object.entries(source.sourceHashes)) assert.equal(hash, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(new URL(`../../${file}`, import.meta.url))).digest('hex')}`);
const cases = [];
function add(name, input) {
  let result;
  try { result = { ok: buildResearchCapabilityMatrix(input) }; } catch (error) { result = { error: error.message }; }
  cases.push({ name, input, result });
}
const fields = ['genericDomainCapabilityReady', 'genericResearchReady', 'academicEmpiricalReady', 'dynamicFormalProjectClosureReady', 'autonomousSubmissionHandoffReady', 'autonomousSubmissionDispatcherReady', 'autonomousSubmissionProviderDraftReady', 'gpuScientificRuntimeReady', 'gpuPdeOperationalProofReady', 'gpuPdeProductionQualificationReady', 'gpuDeepLearningOperationalProofReady', 'gpuDeepLearningProductionQualificationReady', 'fullResearchQualificationReady', 'fullAutomaticResearchWritingReady', 'productionReady', 'fullyAutonomousResearchSystemReady'];
const all = Object.fromEntries(fields.map(field => [field, true]));
add('empty', {});
add('all-ready', all);
for (const field of fields) {
  for (const value of [false, 0, 1, 'true', [], {}, null]) add(`strict-${field}-${JSON.stringify(value)}`, { ...all, [field]: value });
  add(`only-${field}`, { [field]: true });
}
let seed = 17091;
for (let i = 0; i < 256; i += 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const input = Object.fromEntries(fields.map((field, bit) => [field, Boolean(seed & (1 << bit))]));
  add(`mixed-${i}`, input);
}
for (const readiness of [{}, all, { academicEmpiricalReady: true }]) {
  for (const id of buildResearchCapabilityMatrix({}).capabilities.map(c => c.id)) {
    for (const level of ['contract_fixture', 'real_runtime_fixture', 'live_model', 'external_trust', 'made-up', '', null, false, 3, {}, ['live_model']]) {
      add(`explicit-${id}-${JSON.stringify(level)}-${Object.keys(readiness).length}`, { ...readiness, explicitCapabilityEvidenceLevels: { [id]: level } });
    }
    add(`live-${id}-${Object.keys(readiness).length}`, { ...readiness, liveModelEvidenceCapabilityIds: [id] });
  }
}
add('blocker-sort', {genericDomainCapabilityBlockers:['formal_a','formal_a','replay_Z','experiment_x','Ω','😀','\uE000',''],dynamicFormalProjectClosure:{blockers:['😀','\uE000','formal_a']},fullResearchQualificationBlockers:['😀','\uE000','A','a','A',null],autonomousSubmissionDispatcherReadiness:{blockers:['z','a','z'],portalBindingVerified:true,livePortalCanaryVerified:true}});
for (const input of [
  { empiricalLanguagesReady: ['r','python','unknown','python'] },
  { runtimes:{images:{python:{usable:true},r:{usable:true},julia:{usable:true}}} },
  { runtimes:{python:{usable:1},r:{usable:'true'},julia:{usable:true}} },
  { deploymentEnvironmentInspection:{version:2,note:'中文🌍',entries:['x']} },
  { deploymentEnvironmentInspection:false },
  { deploymentEnvironmentInspection:[] },
  { genericDomainCapabilityBlockers:'not-an-array',empiricalLanguagesReady:42 },
]) add('projection-shapes',input);
process.stdout.write(JSON.stringify(cases));
