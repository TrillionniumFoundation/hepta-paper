// Actual incumbent builders, repositories and readers over owned constructed
// data. This does not execute qualification or supply signed acceptance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {receiptHashValid} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository-support.mjs';
import {hashRecord, hashBytes} from '../../workflow-kernel/record-hash.mjs';
import {createAutonomousExternalQualificationState} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {createAutonomousResearchQualificationStateRepository as stateRepository} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {createFullResearchQualificationReceiptPointerRepository as pointerRepository} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES as profiles, RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE as plugin} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const EVIDENCE = 'constructed_data_original_repository_reader_only_no_executed_qualification_or_signed_acceptance';
const now = new Date('2026-09-22T00:00:00.000Z');
const scope = 'owned-reader-paper';
const later = seconds => new Date(now.getTime() + seconds * 1000).toISOString();
const markerHash = label => hashRecord('OwnedQualificationReaderConstructedFixture', {label});
const report = {evidenceScope: EVIDENCE};
function owned(input) {
  const root = path.resolve(input.root);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || fs.realpathSync(root) !== root
    || !root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
    || fs.readFileSync(path.join(root, '.owned-qualification-stored-fixture'), 'utf8') !== 'owned constructed data fixture\n') throw Error('owned_stored_qualification_fixture_required');
  return root;
}
const statePath = root => path.join(root, 'autonomous-research/qualification/external-qualification-state.sqlite');
const mirrorPath = root => path.join(root, 'autonomous-research/qualification/qualification-receipt.json');
const pointerPath = root => mirrorPath(root) + '.publication.sqlite';
function captured(operation) {
  try { return {ok:true,value:operation()}; } catch (error) { return {ok:false,error:error.message}; }
}
function read(root, paperId = scope) {
  return {evidenceScope:EVIDENCE,nowMillis:now.getTime(),paperId,
    pointer:captured(() => pointerRepository({runtimeRoot:root}).read()),
    state:captured(() => {const repository=stateRepository({runtimeRoot:root,paperId,create:false});try{return repository.readExternalQualificationState();}finally{repository.close();}})};
}
function setup(root) {
  const receiptPayload = {
    version: 1,
    kind: 'OwnedConstructedQualificationReaderFixture',
    status: 'constructed_fixture_only',
    externalActionPerformed: false,
    fixtureEvidenceScope: report.evidenceScope,
    campaignId: 'owned-reader-campaign', paperId: scope,
    campaignReleaseBundleHash: markerHash('constructed-release'),
    issuedAt: now.toISOString(), expiresAt: later(3600),
    runtimeImageReproducibilityReceiptHash: markerHash('constructed-runtime-receipt'),
    runtimeImageReproducibilityRequiredProfiles: profiles,
    runtimeImageReproducibilityDefinitionManifestHashes: Object.fromEntries(
      profiles.map(profile => [profile, markerHash(`constructed-definition-${profile}`)])),
    empiricalFamilyPluginPackageHash: plugin.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash: plugin.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash: plugin.empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes: plugin.activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash: plugin.runtimeImageReproducibilityActivePluginScopeHash,
  };
  const receipt = {...receiptPayload, fullResearchQualificationReceiptHash:
    hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', receiptPayload)};
  assert.equal(receiptHashValid(receipt), true);
  const recovery = {
    status: 'qualification_verified', recoveryIdentityHash: markerHash('recovery'),
    recoveryConfigurationIdentityHash: markerHash('recovery-configuration'),
    retryPolicyIdentityHash: markerHash('retry-policy'),
    configurationIdentityHash: markerHash('configuration'), trustIdentityHash: markerHash('trust'),
    clientServiceIdentityHash: markerHash('client'), verifierServiceIdentityHash: markerHash('verifier'),
    terminalFailure: null, cycle: 1, epoch: 1, maximumEpochs: 2,
    attemptCount: 1, maximumAttempts: 2, totalAttemptCount: 1, maximumTotalAttempts: 4,
    firstAttemptAt: now.toISOString(), nextAttemptAt: null, deadlineAt: later(60),
    globalFirstAttemptAt: now.toISOString(), globalDeadlineAt: later(3600),
    maximumTotalCostUsd: 1, reservedCostUsd: 0.1, attemptReservationCostUsd: 0.1,
  };
  const statePayload = {
    version: 4, kind: 'AutonomousExternalQualificationState', generation: 1,
    campaignId: receipt.campaignId, paperId: scope,
    campaignReleaseBundleHash: receipt.campaignReleaseBundleHash,
    receipt,
    verifiedInspection: {
      kind: 'FullResearchQualificationInspection', ready: true, receiptAccepted: true,
      campaignId: receipt.campaignId, paperId: scope,
      campaignReleaseBundleHash: receipt.campaignReleaseBundleHash,
      configurationIdentityHash: recovery.configurationIdentityHash,
      trustIdentityHash: recovery.trustIdentityHash,
      clientServiceIdentityHash: recovery.clientServiceIdentityHash,
      verifierServiceIdentityHash: recovery.verifierServiceIdentityHash,
      fixtureEvidenceScope: report.evidenceScope,
    },
    recovery,
  };
  const state = createAutonomousExternalQualificationState(statePayload);
  const repository = stateRepository({runtimeRoot:root,paperId:scope});
  try { repository.compareAndSwapExternalQualificationState({state}); } finally { repository.close(); }
  const publisher = pointerRepository({runtimeRoot:root});
  const lease = publisher.tryAcquirePublicationLease({ownerId:'owned-fixture-publisher',now});
  publisher.publish({lease,receipt,qualificationStateHash:state.autonomousExternalQualificationStateHash,
    qualificationStateGeneration:state.generation,expectedRuntimeReceiptHash:receipt.runtimeImageReproducibilityReceiptHash,
    publisherFence:{scope:`paper:${scope}`,ownerId:'owned-fixture-publisher',leaseGeneration:1},now});
  return read(root);
}
function setPointer(value, pointer, replacement) {
  const parts=pointer.slice(1).split('/').map(part=>part.replaceAll('~1','/').replaceAll('~0','~'));
  let parent=value;
  for(const part of parts.slice(0,-1)) parent=parent[part];
  parent[parts.at(-1)]=replacement;
}
function seal(value, domain, key) {
  const payload={...value};delete payload[key];return {...payload,[key]:hashRecord(domain,payload)};
}
function stateMutation(root,input, database=null) {
  const db=database || new DatabaseSync(statePath(root));
  try {
    const row=db.prepare('SELECT * FROM autonomous_external_qualification_state WHERE scope=?').get(`paper:${scope}`);
    let state=JSON.parse(row.state_json);
    for(const change of input.changes || []) setPointer(state,change[0],change[1]);
    for(const key of input.removeRecoveryKeys || []) delete state.recovery[key];
    if(input.rehash!==false) state=seal(state,'AutonomousExternalQualificationState','autonomousExternalQualificationStateHash');
    let serialized=JSON.stringify(state);
    if(input.raw==='malformed') serialized='{invalid';
    if(input.raw==='oversize') serialized=' '.repeat(2*1024*1024+1);
    if(input.raw==='numeric-versions') serialized=serialized.replace('"version":4','"version":4.0').replace('"generation":1','"generation":1.0');
    db.prepare('UPDATE autonomous_external_qualification_state SET generation=?,state_hash=?,state_json=? WHERE scope=?').run(input.rowGeneration??state.generation,input.rowHash??state.autonomousExternalQualificationStateHash,serialized,`paper:${scope}`);
  } finally {if(!database)db.close();}
}
function writeMirror(root, bytes) {
  const file=mirrorPath(root);fs.chmodSync(file,0o600);fs.writeFileSync(file,bytes);fs.chmodSync(file,0o444);
}
function pointerMutation(root,input) {
  if(input.scenario==='mirror-whitespace') {writeMirror(root,Buffer.concat([fs.readFileSync(mirrorPath(root)),Buffer.from(' ')]));return;}
  if(input.scenario==='mirror-missing') {fs.unlinkSync(mirrorPath(root));return;}
  if(input.scenario==='mirror-mode') {fs.chmodSync(mirrorPath(root),0o666);return;}
  if(input.scenario==='mirror-invalid') {writeMirror(root,'{invalid');return;}
  const db=new DatabaseSync(pointerPath(root));
  try {
    // Deliberate malformed-row injection into the marker-guarded owned fixture.
    // The production publisher normally prevents this with its CHECK constraint.
    db.exec('PRAGMA ignore_check_constraints=ON');
    const row=db.prepare('SELECT * FROM full_research_qualification_pointer_authority WHERE singleton_id=1').get();
    let receipt=JSON.parse(row.receipt_json);
    for(const change of input.changes || [])setPointer(receipt,change[0],change[1]);
    if(input.scenario==='definition-order') receipt.runtimeImageReproducibilityDefinitionManifestHashes=Object.fromEntries(Object.entries(receipt.runtimeImageReproducibilityDefinitionManifestHashes).reverse());
    if(input.rehash!==false)receipt=seal(receipt,'FullResearchGoldenMicroCampaignQualificationReceipt','fullResearchQualificationReceiptHash');
    let bytes=Buffer.from(JSON.stringify(receipt,input.scenario==='alternate-format'?null:undefined,input.scenario==='alternate-format'?undefined:2)+'\n');
    if(input.scenario==='numeric-version')bytes=Buffer.from(bytes.toString().replace('"version": 1','"version": 1.0'));
    db.prepare('UPDATE full_research_qualification_pointer_authority SET receipt_json=?,receipt_content_hash=?,receipt_hash=?,runtime_receipt_hash=?,issued_at=?,expires_at=?,publication_generation=? WHERE singleton_id=1')
      .run(bytes.toString(),input.scenario==='content-hash-drift'?markerHash('wrong-raw-hash'):hashBytes(bytes),receipt.fullResearchQualificationReceiptHash,receipt.runtimeImageReproducibilityReceiptHash,receipt.issuedAt,receipt.expiresAt,input.publicationGeneration??row.publication_generation);
    writeMirror(root,bytes);
  } finally {db.close();}
}
const input=JSON.parse(process.argv[2]);
const root=owned(input);
if(input.action==='hold-wal') {
  const db=new DatabaseSync(input.database==='pointer'?pointerPath(root):statePath(root));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    if(input.database==='pointer')db.exec('UPDATE full_research_qualification_pointer_authority SET publication_generation=2 WHERE singleton_id=1');
    else stateMutation(root,{changes:[['/generation',2]]},db);
    process.stdout.write(JSON.stringify({profile:productionOracleProfile(),value:{held:true}})+'\n');
    await new Promise(resolve=>{const timer=setTimeout(resolve,30000);process.stdin.once('data',()=>{clearTimeout(timer);resolve();});process.stdin.resume();});
    process.stdin.pause();
  } finally {db.close();}
} else {
  let value;
  if(input.action==='setup')value=setup(root);
  else if(input.action==='read')value=read(root,input.paperId??scope);
  else if(input.action==='state-mutate'){stateMutation(root,input);value=read(root);}
  else if(input.action==='pointer-mutate'){pointerMutation(root,input);value=read(root);}
  else throw Error('stored_qualification_fixture_action_invalid');
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),value}));
}
