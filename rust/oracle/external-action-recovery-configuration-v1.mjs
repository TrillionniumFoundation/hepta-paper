// Original recovery reader/inspection over owned synthetic configuration.
// Ephemeral in-memory signing proves only a contract fixture; no lookup, resume,
// qualification command or independent recovery authority is executed/supplied.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {readExternalResearchQualificationProcessConfiguration as processConfiguration} from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {inspectAutonomousResearchSupervisorExternalActionRecoveryConfiguration as inspect} from '../../paper-adapters/automation/autonomous-research-supervisor-external-action-recovery-process-adapter.mjs';
import {AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_RECOVERY_ACTION_KINDS as actions,verifyAutonomousResearchSupervisorExternalActionRecoveryCapability as verifyCapability} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-recovery-contract.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const EVIDENCE='synthetic_local_signature_contract_fixture_no_recovery_execution_or_independent_authority';
const input=JSON.parse(process.argv[2]);
const root=path.resolve(input.root);
const metadata=fs.lstatSync(root);
if(!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid!==process.getuid() || (metadata.mode&0o077)!==0
 || fs.realpathSync(root)!==root || !root.startsWith(fs.realpathSync(os.tmpdir())+path.sep)
 || fs.readFileSync(path.join(root,'.owned-recovery-configuration-fixture'),'utf8')!=='owned synthetic recovery configuration fixture\n')throw Error('owned_recovery_configuration_fixture_required');
const nowMillis=Date.parse('2026-09-22T00:00:00.000Z');
const configPath=path.join(root,'recovery.json');
function inside(candidate){const resolved=path.resolve(root,candidate);if(!resolved.startsWith(root+path.sep))throw Error('fixture_path_escape');return resolved;}
function observed(config,environment,observedNow=nowMillis){
 const selected=config || environment.HEPTA_AUTONOMOUS_RESEARCH_EXTERNAL_ACTION_RECOVERY_CONFIG;
 if(selected){
  const file=inside(selected);let document;
  try{
   const stat=fs.lstatSync(file);
   if(stat.isFile() && !stat.isSymbolicLink() && stat.uid===process.getuid() && stat.nlink===1
    && (stat.mode&0o077)===0 && stat.size<=256*1024 && fs.realpathSync(file)===file)document=JSON.parse(fs.readFileSync(file,'utf8'));
  }catch{}
  if(typeof document?.processConfigurationPath==='string')inside(path.resolve(path.dirname(file),document.processConfigurationPath));
 }
 return inspect({configPath:config,environment,now:new Date(observedNow)});
}
function setup(){
 fs.writeFileSync(path.join(root,'.owned-qualification-configuration-fixture'),'owned nonsecret fixture\n',{mode:0o600});
 const child=spawnSync(process.execPath,[path.join(import.meta.dirname,'external-qualification-configuration-v3.mjs'),JSON.stringify({action:'setup',root})],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
 if(child.error || child.status!==0)throw Error('bounded_original_v3_fixture_failed');
 const fixture=JSON.parse(child.stdout);assert.deepEqual(fixture.profile,productionOracleProfile());
 const environment=fixture.value.environment;
 const loadedProcess=processConfiguration({configPath:fixture.value.configPath,environment});
 const actionHashes=Object.fromEntries(actions.map(action=>[action,hashRecord('OwnedSyntheticRecoveryActionIdentity',{action,evidenceScope:EVIDENCE})]));
 const pair=crypto.generateKeyPairSync('ed25519');
 const signer={algorithm:'Ed25519',keyId:'owned-synthetic-recovery-key',keyVersion:1,organization:'owned.fixture.recovery',role:'autonomous-research-external-action-recovery-authority',subjectId:'owned-synthetic-recovery-subject'};
 const trustedSigner={...signer,effectiveFrom:'2026-01-01T00:00:00.000Z',expiresAt:'2027-01-01T00:00:00.000Z',revokedAt:null};
 const payload={version:1,kind:'AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt',status:'autonomous_research_supervisor_external_action_recovery_qualified',actionKinds:actions,
 authoritativeSignedLookupSupported:true,definitiveNotFoundSupported:true,idempotentResumeSupported:true,stableKeyContractId:'autonomous-research-supervisor-external-action-stable-key-v1',
 processIdentityHash:loadedProcess.qualifier.commandIdentityHash,recoveryProcessConfigurationIdentityHash:loadedProcess.configurationIdentityHash,recoveryTrustIdentityHash:loadedProcess.trustIdentityHash,
 actionConfigurationIdentityHashes:actionHashes,issuedAt:'2026-09-22T00:00:00.000Z',expiresAt:'2026-09-22T01:00:00.000Z',signer};
 const payloadHash=hashRecord('AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptPayload',payload);
 const signed={...payload,signature:crypto.sign(null,Buffer.from(payloadHash),pair.privateKey).toString('base64')};
 const capabilityReceipt={...signed,autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash:hashRecord('AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt',signed)};
 const standaloneCapabilityValid=verifyCapability(capabilityReceipt,{trustedSigner,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),processIdentityHash:loadedProcess.qualifier.commandIdentityHash,
 recoveryProcessConfigurationIdentityHash:loadedProcess.configurationIdentityHash,recoveryTrustIdentityHash:loadedProcess.trustIdentityHash,now:new Date(nowMillis)});
 assert.equal(standaloneCapabilityValid,true);
 const config={version:1,kind:'AutonomousResearchSupervisorExternalActionRecoveryProcessConfiguration',processCommandRole:'qualifier',processConfigurationPath:fixture.value.configPath,
 processConfigurationIdentityHash:loadedProcess.configurationIdentityHash,actionConfigurationIdentityHashes:actionHashes,capabilityReceipt};
 fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});fs.chmodSync(configPath,0o600);
 const inspection=observed(configPath,environment);
 assert.equal(inspection.ready,false);
 assert.equal(inspection.blocker,'autonomous_research_supervisor_external_action_recovery_capability_not_verified');
 return {evidenceScope:EVIDENCE,configPath,config,environment,nowMillis,standaloneCapabilityValid,inspection};
}
let value;
if(input.action==='setup')value=setup();
else if(input.action==='inspect')value={evidenceScope:EVIDENCE,inspection:observed(input.configPath??null,input.environment??{},input.nowMillis??nowMillis)};
else throw Error('owned_recovery_fixture_action_invalid');
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),value}));
