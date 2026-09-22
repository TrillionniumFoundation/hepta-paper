// Pure original-module oracle. No SQLite, process execution, authority hook,
// provider call, or claim that the constructed recorded actions occurred.
if (typeof process.argv[2] !== 'string' || Buffer.byteLength(process.argv[2]) > 65536) {
  throw Error('topic_canary_oracle_argument_bound');
}
JSON.parse(process.argv[2]);
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousResearchProviderCanaryAttemptJournal as buildJournal,
  buildAutonomousResearchProviderCanarySideEffectInspection as buildInspection,
  verifyAutonomousResearchProviderCanaryAttemptJournal as verifyJournal,
  verifyAutonomousResearchProviderCanarySideEffectInspection as verifyInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {parseGeneration} from '../../paper-adapters/automation/autonomous-research-topic-producer-repository-support.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const H = character => `sha256:${character.repeat(64)}`;
const P = H('a');
const clone = value => JSON.parse(JSON.stringify(value));
const reservation = {
  generationSequence: 1,
  plannedGenerationHash: H('b'),
  budgetReservationId: 'owned-reservation',
  budgetEpochStart: '2026-09-22T00:00:00.000Z',
  providerCanaryReservedAttemptCount: 1,
  providerCanaryReservedCostUsd: 0.25,
};
const action = (role, status) => ({
  role, status,
  providerCanaryReceiptHash: status === 'succeeded' ? H('c') : null,
  errorCode: status === 'succeeded' ? null : `${role}_canary_failed`,
});
const actionSets = [[], [action('research_author', 'succeeded')], [action('research_author', 'failed')]];
for (const author of ['succeeded', 'failed']) {
  for (const reviewer of ['succeeded', 'failed']) {
    actionSets.push([action('research_author', author), action('formal_reviewer', reviewer)]);
  }
}
function rehash(value, type) {
  const domain = type === 'journal' ? 'AutonomousResearchProviderCanaryAttemptJournal' : 'AutonomousResearchProviderCanarySideEffectInspection';
  const key = type === 'journal' ? 'autonomousResearchProviderCanaryAttemptJournalHash' : 'autonomousResearchProviderCanarySideEffectInspectionHash';
  const {[key]: ignored, ...payload} = value;
  return {...payload, [key]: hashRecord(domain, payload)};
}
const cases = [];
function add(name, type, value, options = {}) {
  const expected = {};
  if (options.providerBinding === 'self') expected.providerConfigurationHash = value.providerConfigurationHash;
  else if (options.providerBinding === 'clone') expected.providerConfigurationHash = clone(value.providerConfigurationHash);
  else if (Object.hasOwn(options, 'provider')) expected.providerConfigurationHash = options.provider;
  if (options.reservationBinding === 'self') expected.reservation = value.reservation;
  else if (options.reservationBinding === 'clone') expected.reservation = clone(value.reservation);
  else if (Object.hasOwn(options, 'reservation')) expected.reservation = options.reservation;
  let result;
  try { result = {ok: true, value: (type === 'journal' ? verifyJournal : verifyInspection)(value, expected)}; }
  catch (error) { result = {ok: false, error: error.message}; }
  cases.push({name, type, value, options, expected: result});
}
let index = 0;
for (const actions of actionSets) {
  for (const currentRole of [null, 'research_author', 'formal_reviewer']) {
    for (const failurePhase of ['provider_canary_reserved', 'owned_phase']) {
      try {
        const value = buildJournal({providerConfigurationHash:P, reservation, actions, currentRole, failurePhase});
        add(`builder-journal-${index++}`, 'journal', value, {provider:P, reservation:clone(reservation)});
      } catch (error) {
        if (error.message !== 'autonomous_research_provider_canary_attempt_journal_invalid') throw error;
      }
    }
  }
  for (const actionAccountingComplete of [false, true]) {
    const value = buildInspection({providerConfigurationHash:P, reservation, actions, actionAccountingComplete, failurePhase:'owned_phase'});
    add(`builder-inspection-${index++}`, 'inspection', value, {provider:P, reservation:clone(reservation)});
  }
}
const baseJournal = buildJournal({providerConfigurationHash:P, reservation, actions:[], currentRole:null, failurePhase:'provider_canary_reserved'});
const baseInspection = buildInspection({providerConfigurationHash:P, reservation, actions:actionSets[1], failurePhase:'owned_phase'});
for (const [name, mutate] of [
  ['version-string', v=>{v.version='1';}],
  ['extra-key', v=>{v.extra=true;}],
  ['wrong-hash', v=>{v.autonomousResearchProviderCanaryAttemptJournalHash=H('d');}],
  ['unknown-current-role', v=>{v.currentRole='other';}],
  ['zero-phase-array', v=>{v.failurePhase=['provider_canary_reserved'];}],
  ['uppercase-sha', v=>{v.providerConfigurationHash=P.toUpperCase();}],
  ['unsafe-generation', v=>{v.reservation.generationSequence=9007199254740992;}],
  ['noncanonical-epoch', v=>{v.reservation.budgetEpochStart='2026-09-22T00:00:00Z';}],
  ['negative-cost', v=>{v.reservation.providerCanaryReservedCostUsd=-1;}],
  ['string-cost', v=>{v.reservation.providerCanaryReservedCostUsd='0.25';}],
]) {
  const value=clone(baseJournal); mutate(value);
  add(name, 'journal', name==='wrong-hash'?value:rehash(value,'journal'));
}
for (const [name, mutate] of [
  ['incorrect-count', v=>{v.providerCanaryActionCount=2;}],
  ['incorrect-may-have-occurred', v=>{v.externalActionMayHaveOccurred=false;}],
  ['string-accounting', v=>{v.actionAccountingComplete='true';}],
  ['failed-code-array', v=>{v.failureCode=['owned_phase_failed'];}],
  ['wrong-role-order', v=>{v.actions[0].role='formal_reviewer';}],
  ['action-sequence-string', v=>{v.actions[0].sequence='1';}],
]) {
  const value=clone(baseInspection); mutate(value); add(name,'inspection',rehash(value,'inspection'));
}
for (const provider of [null,false,0,'',P,H('d'),[P]]) add(`provider-option-${JSON.stringify(provider)}`,'journal',baseJournal,{provider});
for (const reservationOption of [null,false,0,'',clone(reservation),{...reservation,generationSequence:2}]) add(`reservation-option-${JSON.stringify(reservationOption)}`,'journal',baseJournal,{reservation:reservationOption});
const arrayJournal=rehash({...clone(baseJournal),providerConfigurationHash:[P],reservation:{...reservation,plannedGenerationHash:[H('b')],budgetReservationId:['owned-reservation']}},'journal');
for(const options of [{},{providerBinding:'self',reservationBinding:'self'},{providerBinding:'clone',reservationBinding:'self'},{providerBinding:'self',reservationBinding:'clone'}]) add(`array-reference-${JSON.stringify(options)}`,'journal',arrayJournal,options);
const coercionInspection=clone(baseInspection);
coercionInspection.failurePhase=['owned_phase'];
coercionInspection.actions[0].providerCanaryReceiptHash=[[H('c')]];
add('phase-and-action-hash-array-positive','inspection',rehash(coercionInspection,'inspection'));
const failedWeird=clone(buildInspection({providerConfigurationHash:P,reservation,actions:[action('research_author','failed')],failurePhase:'owned_phase'}));
failedWeird.actions[0].providerCanaryReceiptHash={recorded:'not-a-hash'};
failedWeird.actions[0].errorCode=['owned_error'];
add('failed-nonnull-nonhash-and-code-array','inspection',rehash(failedWeird,'inspection'));
const throwingHash=clone(failedWeird);throwingHash.actions[0].providerCanaryReceiptHash={toString:1};
add('failed-hash-string-coercion-error','inspection',rehash(throwingHash,'inspection'));

// This intentionally matches the original weaker parseGeneration contract:
// planned hash/claims are recorded fixture data, not a full planned builder or
// accepted authority. No positive execution claim is inferred from this row.
const planned={plannedGenerationHash:H('b'),generationSequence:1,producerTopicId:'owned:1',topicFingerprint:H('d'),canonicalResearchTopicHash:H('e'),budgetReservationId:reservation.budgetReservationId,budgetEpochStart:reservation.budgetEpochStart,recordedExtra:'retained'};
function row() { return {
  generation_sequence:1,status:'planned',lease_generation:1,
  producer_topic_id:planned.producerTopicId,topic_fingerprint:planned.topicFingerprint,
  canonical_research_topic_hash:planned.canonicalResearchTopicHash,budget_reservation_id:planned.budgetReservationId,budget_epoch_start:planned.budgetEpochStart,
  planned_generation_hash:planned.plannedGenerationHash,planned_generation_json:JSON.stringify(planned),
  capability_hash:null,capability_nonce:null,capability_json:null,intake_id:null,intake_hash:null,admission_hash:null,error:null,
  provider_canary_attempt_started:0,provider_canary_attempt_journal_json:null,provider_canary_side_effect_inspection_json:null,
  created_at:'2026-09-22T00:00:00.000Z',updated_at:'2026-09-22T00:00:00.000Z',
}; }
const rows=[];
function addRow(name,value,options={}) {
  let expected;
  try {expected={ok:true,value:parseGeneration(value,{providerConfigurationHash:options.provider??null,providerCanaryPairMaximumCostUsd:options.maxCost??null})};}
  catch(error){expected={ok:false,error:error.message};}
  // Serialization here intentionally projects undefined omission and NaN→null.
  rows.push(JSON.parse(JSON.stringify({name,row:value,options,expected})));
}
for(const absent of [null,false,0,''])addRow(`falsy-row-${JSON.stringify(absent)}`,absent);
addRow('recorded-planned-without-full-rehash',row());
for(const started of [0,1])for(const status of ['planned','authorized','produced','failed'])addRow(`no-journal-${started}-${status}`,{...row(),status,provider_canary_attempt_started:started});
addRow('zero-action-journal', {...row(),provider_canary_attempt_started:1,provider_canary_attempt_journal_json:JSON.stringify(baseJournal)},{provider:P});
addRow('journal-wrong-provider', {...row(),provider_canary_attempt_started:1,provider_canary_attempt_journal_json:JSON.stringify(baseJournal)},{provider:H('d')});
addRow('journal-cost-fallback', {...row(),provider_canary_attempt_started:1,provider_canary_attempt_journal_json:JSON.stringify(baseJournal)},{provider:P});
addRow('journal-explicit-wrong-cost', {...row(),provider_canary_attempt_started:1,provider_canary_attempt_journal_json:JSON.stringify(baseJournal)},{provider:P,maxCost:0.5});
const prefixJournal=buildJournal({providerConfigurationHash:P,reservation,actions:actionSets[1],currentRole:null,failurePhase:'owned_phase'});
const inspection=buildInspection({providerConfigurationHash:P,reservation,actions:[...actionSets[1],action('formal_reviewer','failed')],failurePhase:'owned_phase'});
const failureRow={...row(),status:'failed',error:inspection.failureCode,provider_canary_attempt_started:1,provider_canary_attempt_journal_json:JSON.stringify(prefixJournal),provider_canary_side_effect_inspection_json:JSON.stringify(inspection)};
addRow('real-builder-action-prefix',failureRow,{provider:P});
const reordered=clone(inspection);reordered.actions[0]=Object.fromEntries(Object.entries(reordered.actions[0]).reverse());
addRow('raw-action-member-order-mismatch',{...failureRow,provider_canary_side_effect_inspection_json:JSON.stringify(reordered)},{provider:P});
addRow('inspection-without-journal',{...failureRow,provider_canary_attempt_journal_json:null},{provider:P});
addRow('failed-code-mismatch',{...failureRow,error:'other_failed'},{provider:P});
addRow('inspection-wrong-status',{...failureRow,status:'produced'},{provider:P});
for(const document of [null,{},false,{actions:null}])addRow(`inspection-actions-type-error-${JSON.stringify(document)}`,{...failureRow,provider_canary_side_effect_inspection_json:JSON.stringify(document)},{provider:P});
addRow('empty-journal-null-inspection-normal-invalid',{...failureRow,provider_canary_attempt_journal_json:JSON.stringify(baseJournal),provider_canary_side_effect_inspection_json:'null'},{provider:P});
addRow('absent-journal-null-inspection-normal-invalid',{...failureRow,provider_canary_attempt_journal_json:null,provider_canary_side_effect_inspection_json:'null'},{provider:P});
addRow('capability-only-hash-nonce-binding',{...row(),capability_hash:H('f'),capability_nonce:'recorded-only',capability_json:JSON.stringify({autonomousResearchTopicProducerCapabilityReceiptHash:H('f'),capabilityNonce:'recorded-only',unverifiedExtra:true})});
for(const value of ['{','null','false','{}'])addRow(`capability-json-${value}`,{...row(),capability_json:value});
const falseCap={...row(),capability_json:'false'};delete falseCap.capability_hash;delete falseCap.capability_nonce;addRow('false-capability-with-undefined-bindings',falseCap);
for(const value of ['1',' 1 ','0x1',[1]])addRow(`generation-number-${JSON.stringify(value)}`,{...row(),generation_sequence:value});
for(const value of [null,false,'',[],[0],'Infinity','not-number'])addRow(`started-number-${JSON.stringify(value)}`,{...row(),provider_canary_attempt_started:value});
for(const value of ['not-number','Infinity',null])addRow(`lease-number-${JSON.stringify(value)}`,{...row(),lease_generation:value});
for(const field of ['generation_sequence','provider_canary_attempt_started','lease_generation'])addRow(`number-coercion-type-error-${field}`,{...row(),[field]:{toString:1}});
const missingDates=row();delete missingDates.created_at;delete missingDates.updated_at;addRow('undefined-output-fields-omitted',missingDates);
const arrayPlanned={...planned,budgetReservationId:['owned-reservation']};
const arrayReservationJournal=rehash({...baseJournal,reservation:{...reservation,budgetReservationId:['owned-reservation']}},'journal');
addRow('separately-parsed-array-identity-refusal',{...row(),budget_reservation_id:['owned-reservation'],planned_generation_json:JSON.stringify(arrayPlanned),provider_canary_attempt_started:1,provider_canary_attempt_journal_json:JSON.stringify(arrayReservationJournal)});

const output=JSON.stringify({profile:productionOracleProfile(),value:{evidenceScope:'original_pure_recorded_canary_and_generation_contracts_no_provider_or_authority_acceptance',cases,rows}});
if(Buffer.byteLength(output)>2*1024*1024)throw Error('topic_canary_oracle_output_bound');
process.stdout.write(output);
