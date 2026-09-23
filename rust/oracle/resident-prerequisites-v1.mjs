// Actual original resident composition over owned synthetic configuration and
// stored data, with ephemeral in-memory release signatures. No qualification,
// recovery, provider or independent authority is executed/established.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {readExternalResearchQualificationProcessConfiguration as readConfiguration} from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {createAutonomousExternalQualificationState} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {createAutonomousResearchQualificationStateRepository as stateRepository} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {createFullResearchQualificationReceiptPointerRepository as pointerRepository} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {fullResearchQualificationSigningPayloadHash} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {currentCodeProvenance} from '../../paper-adapters/runtime/code-provenance.mjs';
import {inspectAutonomousResearchResidentPrerequisites as inspect} from '../../paper-composition/automation/autonomous-research-resident-prerequisite-inspection.mjs';
import {REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES as profiles,RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE as plugin} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const EVIDENCE='synthetic_local_resident_signature_and_storage_fixture_no_executed_qualification_or_independent_acceptance';
const input=JSON.parse(process.argv[2]);
const root=path.resolve(input.root);
const stat=fs.lstatSync(root);
if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode&0o077)!==0 || fs.realpathSync(root)!==root
 || !root.startsWith(fs.realpathSync(os.tmpdir())+path.sep) || fs.readFileSync(path.join(root,'.owned-resident-prerequisites-fixture'),'utf8')!=='owned synthetic resident prerequisites fixture\n')throw Error('owned_resident_prerequisites_fixture_required');
const repositoryRoot=path.resolve(import.meta.dirname,'../..');
const NOW=Date.parse('2026-09-22T00:00:00.000Z');
const iso=time=>new Date(time).toISOString();
const marker=label=>hashRecord('OwnedSyntheticResidentFixture',{label,evidenceScope:EVIDENCE});
const configPath=path.join(root,'configuration.json');
const fixturePath=path.join(root,'resident-fixture.json');
function privateWrite(file,value){fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);}
function inspectActual(environment,nowMillis=NOW,selected=configPath,recovery=null){
 if(selected!==null && !path.resolve(root,selected).startsWith(root+path.sep))throw Error('owned_selected_configuration_required');
 if(recovery!==null && !path.resolve(root,recovery).startsWith(root+path.sep))throw Error('owned_recovery_configuration_required');
 return inspect({runtimeRoot:root,repositoryRoot,environment,externalQualificationConfigPath:selected,externalActionRecoveryConfigPath:recovery,now:new Date(nowMillis)});
}
function signer(configuration){return Object.fromEntries(['algorithm','keyId','keyVersion','organization','role','subjectId'].map(key=>[key,configuration[key]]));}
function setup(){
 privateWrite(path.join(root,'.owned-qualification-configuration-fixture'),'owned nonsecret fixture\n');
 const child=spawnSync(process.execPath,[path.join(import.meta.dirname,'external-qualification-configuration-v3.mjs'),JSON.stringify({action:'setup',root})],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
 if(child.error || child.status!==0)throw Error('bounded_original_v3_fixture_failed');
 const original=JSON.parse(child.stdout);assert.deepEqual(original.profile,productionOracleProfile());
 const environment=original.value.environment;
 const active=crypto.generateKeyPairSync('ed25519'),retiring=crypto.generateKeyPairSync('ed25519');
 privateWrite(path.join(root,'release-public.pem'),active.publicKey.export({type:'spki',format:'pem'}));
 privateWrite(path.join(root,'retiring-public.pem'),retiring.publicKey.export({type:'spki',format:'pem'}));
 const configuration=readConfiguration({configPath,environment});
 const code=currentCodeProvenance({workspaceRoot:repositoryRoot});
 const scenario=input.scenario??'valid-signed';
 let issued=NOW,expires=NOW+3_600_000;
 if(scenario==='expired'){issued=NOW-7_200_000;expires=NOW-3_600_000;}
 if(scenario==='future'){issued=NOW+60_000;expires=NOW+3_660_000;}
 let payload={version:1,kind:'FullResearchGoldenMicroCampaignQualificationReceipt',status:'full_research_golden_micro_campaign_qualified',externalActionPerformed:true,
  fixtureEvidenceScope:EVIDENCE,campaignId:'owned-resident-campaign',paperId:'owned-resident-paper',campaignReleaseBundleHash:marker('release'),issuedAt:iso(issued),expiresAt:iso(expires),codeProvenance:code,
  runtimeImageReproducibilityReceiptHash:marker('runtime'),runtimeImageReproducibilityRequiredProfiles:profiles,
  runtimeImageReproducibilityDefinitionManifestHashes:Object.fromEntries(profiles.map(profile=>[profile,marker(`definition-${profile}`)])),
  empiricalFamilyPluginPackageHash:plugin.empiricalFamilyPluginPackageHash,empiricalFamilyPluginRegistryHash:plugin.empiricalFamilyPluginRegistryHash,
  empiricalFamilyPluginStartupInspectionHash:plugin.empiricalFamilyPluginStartupInspectionHash,activeEmpiricalProductionProfileHashes:plugin.activeProductionProfileHashes,
  runtimeImageReproducibilityActivePluginScopeHash:plugin.runtimeImageReproducibilityActivePluginScopeHash,signer:signer(configuration.trustedSigner)};
 let signingKey=active.privateKey;
 if(scenario==='retiring-signer'){payload.signer=signer(configuration.trustedSigners.find(value=>value.status==='retiring'));signingKey=retiring.privateKey;}
 if(scenario==='bad-signature')signingKey=retiring.privateKey;
 if(scenario==='code-drift')payload.codeProvenance={...code,worktreeStateHash:marker('other-code')};
 if(scenario==='wrong-kind')payload.kind='OwnedConstructedWrongKind';
 if(scenario==='no-external-action')payload.externalActionPerformed=false;
 if(scenario==='extra-signed-field')payload.additionalSignedFixtureField={values:[1,1.25,'🧪']};
 let signature=crypto.sign(null,Buffer.from(fullResearchQualificationSigningPayloadHash(payload)),signingKey).toString('base64');
 if(scenario==='unicode-signature')signature=[...signature].map(char=>String.fromCharCode(char.charCodeAt(0)+0x100)).join('');
 if(scenario==='permissive-signature')signature='!'+signature.replaceAll('+','-').replaceAll('/','_').replaceAll('=','')+'\n';
 payload={...payload,signature};
 const receipt={...payload,fullResearchQualificationReceiptHash:hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt',payload)};
 const recoveryIdentity={configurationIdentityHash:configuration.configurationIdentityHash,trustIdentityHash:configuration.trustIdentityHash,
  clientServiceIdentityHash:configuration.clientServiceIdentityHash,verifierServiceIdentityHash:configuration.verifierServiceIdentityHash,
  maximumQualificationCostUsd:configuration.maximumQualificationCostUsd,qualificationCostAuthority:configuration.qualificationCostAuthority};
 if(scenario==='state-config-drift')recoveryIdentity.configurationIdentityHash=marker('other-config');
 if(scenario==='state-cost-drift')recoveryIdentity.maximumQualificationCostUsd+=1;
 const recovery={status:'qualification_verified',recoveryIdentityHash:marker('recovery'),recoveryConfigurationIdentityHash:hashRecord('AutonomousExternalQualificationRecoveryConfigurationIdentity',recoveryIdentity),
  retryPolicyIdentityHash:marker('retry'),configurationIdentityHash:recoveryIdentity.configurationIdentityHash,trustIdentityHash:recoveryIdentity.trustIdentityHash,
  clientServiceIdentityHash:recoveryIdentity.clientServiceIdentityHash,verifierServiceIdentityHash:recoveryIdentity.verifierServiceIdentityHash,
  terminalFailure:null,cycle:1,epoch:1,maximumEpochs:2,attemptCount:1,maximumAttempts:2,totalAttemptCount:1,maximumTotalAttempts:4,
  firstAttemptAt:iso(issued),nextAttemptAt:null,deadlineAt:iso(issued+60_000),globalFirstAttemptAt:iso(issued),globalDeadlineAt:iso(issued+3_600_000),
  maximumTotalCostUsd:1,reservedCostUsd:0.1,attemptReservationCostUsd:0.1};
 const state=createAutonomousExternalQualificationState({version:4,kind:'AutonomousExternalQualificationState',generation:1,campaignId:receipt.campaignId,paperId:receipt.paperId,
  campaignReleaseBundleHash:receipt.campaignReleaseBundleHash,receipt,verifiedInspection:{kind:'FullResearchQualificationInspection',ready:true,receiptAccepted:true,
   campaignId:receipt.campaignId,paperId:receipt.paperId,campaignReleaseBundleHash:receipt.campaignReleaseBundleHash,configurationIdentityHash:recovery.configurationIdentityHash,
   trustIdentityHash:recovery.trustIdentityHash,clientServiceIdentityHash:recovery.clientServiceIdentityHash,verifierServiceIdentityHash:recovery.verifierServiceIdentityHash,fixtureEvidenceScope:EVIDENCE},recovery});
 let renewalBefore=null;
 if(scenario!=='missing-pointer'){
  const repository=stateRepository({runtimeRoot:root,paperId:receipt.paperId});try{repository.compareAndSwapExternalQualificationState({state});}finally{repository.close();}
  const publisher=pointerRepository({runtimeRoot:root});const now=new Date(issued);
  const lease=publisher.tryAcquirePublicationLease({ownerId:'owned-resident-fixture',now});
  publisher.publish({lease,receipt,qualificationStateHash:state.autonomousExternalQualificationStateHash,qualificationStateGeneration:state.generation,
   expectedRuntimeReceiptHash:receipt.runtimeImageReproducibilityReceiptHash,publisherFence:{scope:`paper:${receipt.paperId}`,ownerId:'owned-resident-fixture',leaseGeneration:1},now});
  if(scenario==='renewed-receipt'){
   renewalBefore=inspectActual(environment,NOW);
   const renewedPayload={...payload,issuedAt:iso(issued+1),expiresAt:iso(expires+1000)};delete renewedPayload.signature;
   renewedPayload.signature=crypto.sign(null,Buffer.from(fullResearchQualificationSigningPayloadHash(renewedPayload)),active.privateKey).toString('base64');
   const renewedReceipt={...renewedPayload,fullResearchQualificationReceiptHash:hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt',renewedPayload)};
   const {autonomousExternalQualificationStateHash:ignored,...statePayload}=state;
   const renewedState=createAutonomousExternalQualificationState({...statePayload,generation:2,receipt:renewedReceipt});
   const nextRepository=stateRepository({runtimeRoot:root,paperId:receipt.paperId});
   try{nextRepository.compareAndSwapExternalQualificationState({expectedStateHash:state.autonomousExternalQualificationStateHash,state:renewedState});}finally{nextRepository.close();}
   publisher.publish({lease,receipt:renewedReceipt,qualificationStateHash:renewedState.autonomousExternalQualificationStateHash,qualificationStateGeneration:2,
    expectedRuntimeReceiptHash:renewedReceipt.runtimeImageReproducibilityReceiptHash,publisherFence:{scope:`paper:${receipt.paperId}`,ownerId:'owned-resident-fixture',leaseGeneration:1},now:new Date(issued+1)});
  }
 }
 let recoveryConfigPath=null;
 if(scenario==='configured-recovery'){
  recoveryConfigPath=path.join(root,'recovery.json');privateWrite(recoveryConfigPath,{version:1,kind:'AutonomousResearchSupervisorExternalActionRecoveryProcessConfiguration',processCommandRole:'qualifier',
   processConfigurationPath:configPath,processConfigurationIdentityHash:configuration.configurationIdentityHash,
   actionConfigurationIdentityHashes:Object.fromEntries(['golden-release-attestor','production-readiness','provider-canary'].map(action=>[action,marker(action)])),capabilityReceipt:{}});
 }
 const observedNow=scenario==='renewed-receipt'?NOW+1:NOW;
 const data={environment,configPath,recoveryConfigPath,nowMillis:observedNow,scenario,renewalBefore};privateWrite(fixturePath,data);
 const inspection=inspectActual(environment,observedNow,configPath,recoveryConfigPath);
 if(renewalBefore){assert.equal(inspection.autonomousResearchResidentPrerequisiteIdentityHash,renewalBefore.autonomousResearchResidentPrerequisiteIdentityHash);assert.notEqual(inspection.autonomousResearchResidentPrerequisiteReceiptHash,renewalBefore.autonomousResearchResidentPrerequisiteReceiptHash);}
 if(['valid-signed','extra-signed-field','unicode-signature','permissive-signature','configured-recovery','renewed-receipt'].includes(scenario))assert.deepEqual(inspection.globalQualificationBlockers,['autonomous_research_runtime_reproducibility_receipt_not_current']);
 assert.equal(inspection.ready,false);assert.equal(inspection.externalActionPerformed,false);assert.equal(fs.existsSync(path.join(root,'executed-marker')),false);
 return {evidenceScope:EVIDENCE,...data,inspection};
}
let value;
if(input.action==='setup')value=setup();
else if(input.action==='inspect'){
 const data=JSON.parse(fs.readFileSync(fixturePath,'utf8'));value={evidenceScope:EVIDENCE,...data,inspection:inspectActual(input.environment??data.environment,input.nowMillis??data.nowMillis,
  input.configPath===null?null:input.configPath??data.configPath,input.recoveryConfigPath===null?null:input.recoveryConfigPath??data.recoveryConfigPath)};
}else throw Error('owned_resident_fixture_action_invalid');
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),value}));
