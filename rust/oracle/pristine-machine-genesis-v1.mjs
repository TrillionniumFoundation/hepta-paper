// Only the original external-document loader is substituted at its established
// test seam. All original genesis structure, time, Ed25519, and persistence checks run.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashRecord,hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { installAutonomousResearchMachineIntakeExternalAuthorityTestDouble } from '../../paper-core/tests/test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const real=relative=>pathToFileURL(fs.realpathSync(new URL(relative,import.meta.url))).href;
const authority=real('../../paper-adapters/automation/autonomous-research-machine-intake-authority.mjs');
const authorization=real('../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs');
const double=real('../../paper-core/tests/test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs');
registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context);return context.parentURL?.split('?')[0]===authority&&resolved.url===authorization?{shortCircuit:true,url:double}:resolved;}});
const {inspectAutonomousResearchPristineDatabaseState:inspect}=await import('../../paper-adapters/automation/autonomous-research-pristine-runtime-state.mjs');
let documents=null;installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(()=>documents);
const request=JSON.parse(fs.readFileSync(0,'utf8'));
try {
  if(!request.root.startsWith('/tmp/hepta-pristine-rust-')||!request.input.databasePath.startsWith('/tmp/hepta-pristine-rust-'))throw new Error('isolated_fixture_required');
  const cases=[];
  for(const scenario of ['valid','signature','distinct-subject','missing-role','expired','persisted-splice','payload-hash','extra-key','numeric-shared-subject','numeric-distinct-subject']){
    const databasePath=path.join(request.root,`genesis-${scenario}.sqlite`);fs.copyFileSync(request.input.databasePath,databasePath);const database=new DatabaseSync(databasePath);
    try {
      const old=database.prepare('SELECT * FROM autonomous_research_machine_intake_authority_genesis').get();
      const created=old.created_at;const later=new Date(Date.parse(created)+86400000).toISOString();const earlier=new Date(Date.parse(created)-86400000).toISOString();
      const pairs=[crypto.generateKeyPairSync('ed25519'),crypto.generateKeyPairSync('ed25519')];
      const roles=['capability_owner','operational_observer'];
      const ownerTrustStore={version:1,kind:'AuthorityTrustStore',keys:pairs.map((pair,i)=>({algorithm:'ed25519',effectiveFrom:earlier,expiresAt:later,keyId:`key:${i}`,organization:'test-only',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),revokedAt:null,roles:[roles[i]],status:'active',subjectId:scenario==='distinct-subject'?'subject:shared':`subject:${i}`}))};
      if(scenario==='numeric-shared-subject')for(const key of ownerTrustStore.keys)key.subjectId=7;
      if(scenario==='numeric-distinct-subject')for(let i=0;i<2;i++)ownerTrustStore.keys[i].subjectId=i+7;
      if(scenario==='missing-role')ownerTrustStore.keys[1].roles=['capability_owner'];
      const ownerTrustStoreHash=hashRecord('AuthorityTrustStore',ownerTrustStore);
      let envelope={version:1,kind:'AutonomousResearchMachineIntakeAuthorityGenesisEnvelope',status:'external_genesis_authority_verified',configurationHash:old.configuration_hash,producerProfileHash:old.producer_profile_hash,authorityGeneration:1,ownerTrustStoreHash,nonce:'pristine-genesis:test',signedAt:created,validFrom:created,expiresAt:scenario==='expired'?created:later,signatures:[]};
      if(scenario==='extra-key')envelope.extra=true;
      for(let i=0;i<2;i++)envelope=signAuthorityDocument(envelope,{privateKeyPem:pairs[i].privateKey.export({type:'pkcs8',format:'pem'}),keyId:`key:${i}`,role:roles[i]});
      if(scenario==='signature')envelope.signatures[0].value='AA==';
      const envelopeHash=hashRecord('AutonomousResearchMachineIntakeAuthorityGenesisEnvelope',envelope);
      const payload={version:1,kind:'AutonomousResearchMachineIntakeAuthorityGenesis',origin:'fresh-v2-genesis',configurationHash:old.configuration_hash,producerProfileHash:old.producer_profile_hash,authorityGeneration:1,createdAt:created,externalGenesisEnvelopeHash:envelopeHash,ownerTrustStoreHash};
      const signers=ownerTrustStore.keys.map((key,i)=>({keyId:key.keyId,subjectId:String(key.subjectId||key.keyId),organization:key.organization||null,role:roles[i]}));
      const persisted=structuredClone(envelope);if(scenario==='persisted-splice')persisted.nonce='other-genesis:test';
      for(const {name} of database.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='autonomous_research_machine_intake_authority_genesis'").all())database.exec(`DROP TRIGGER "${name.replaceAll('"','""')}";`);
      database.prepare(`UPDATE autonomous_research_machine_intake_authority_genesis SET origin=?,genesis_payload_json=?,external_genesis_envelope_json=?,owner_trust_store_snapshot_json=?,verified_signers_json=?,external_genesis_envelope_hash=?,owner_trust_store_hash=?,genesis_hash=?`).run('fresh-v2-genesis',JSON.stringify(payload),JSON.stringify(persisted),JSON.stringify(ownerTrustStore),JSON.stringify(signers),envelopeHash,ownerTrustStoreHash,scenario==='payload-hash'?hashRecord('Other',{}):hashRecord('AutonomousResearchMachineIntakeAuthorityGenesis',payload));
      documents={ownerTrustStore,genesisEnvelope:envelope,rotationTrustStore:{},bootstrapReceipt:{}};
      const pins={};for(const [label,document]of Object.entries(documents)){const selected=path.join(request.root,`${scenario}-${label}.json`);fs.writeFileSync(selected,JSON.stringify(document),{mode:0o600});pins[label]={path:selected,hash:hashBytes(fs.readFileSync(selected))};}
      const input={...request.input,databasePath};let result;try{result={ok:true,value:inspect({...input,database})};}catch(error){result={ok:false,error:error.message};}
      cases.push({scenario,input,pins,result});
    } finally {database.close();}
  }
  process.stdout.write(JSON.stringify({ok:true,cases,profile:productionOracleProfile()}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message,profile:productionOracleProfile()}));}
