// TEST-ONLY local ephemeral authorities and files. No real portal or credentials.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runPortalTargetQualificationCli } from '../../paper-core/bin/portal-target-qualification.mjs';
import { inspectPortalTargetQualificationRegistry, preflightPortalTargetQualificationRegistry, planPortalTargetQualificationRegistryImport, executePortalTargetQualificationRegistryImport } from '../../paper-adapters/submission/portal-target-qualification-registry-repository.mjs';
import { PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES as ROLES, PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES as POLICIES, buildPortalTargetQualification, buildPortalTargetQualificationEvidenceAttestation, buildPortalTargetQualificationRegistry, buildPortalTargetQualificationSubjectHash } from '../../paper-domain/submission/portal-target-qualification-contract.mjs';
import { getJournalSubmissionTargetProfile } from '../../paper-domain/submission/journal-submission-target-registry.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
import { qualificationFixtures } from './journal-qualification-fixtures-v1.mjs';

const sha = label => hashRecord('PortalOperatorTestOnly', { label });
function fixtures(now) {
  const authorities = [ROLES.owner, ROLES.observer, ROLES.productionAuthorizer].map((role, index) => {
    const pair = crypto.generateKeyPairSync('ed25519');
    return { privateKeyPem:pair.privateKey.export({type:'pkcs8',format:'pem'}), key:{keyId:`operator-test-${index}`,subjectId:`operator-test-subject:${index}`,organization:`operator-test-organization:${index}`,roles:[role],algorithm:'ed25519',status:'active',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})} };
  });
  const sign = (document, indexes) => indexes.reduce((value,index) => signAuthorityDocument(value,{privateKeyPem:authorities[index].privateKeyPem,keyId:authorities[index].key.keyId,role:authorities[index].key.roles[0]}), {...document,signatures:[]});
  const trust = {version:1,kind:'AuthorityTrustStore',keys:authorities.map(a=>a.key)};
  function entry(venue,at,sandbox=false,route='route') {
    const profile=getJournalSubmissionTargetProfile(venue);
    const binding={venueId:venue,venueKind:profile.venueKind,baseTargetProfileHash:profile.journalSubmissionTargetProfileHash,targetInstanceId:`TEST_ONLY/${venue}/2026`,edition:profile.venueKind==='conference'?'2026':null,track:profile.venueKind==='conference'?'test':null,connectorFamily:'openreview-api-v2',portalOriginHash:sha('origin'),submissionRouteHash:sha(route),schemaFingerprintHash:sha('schema'),authenticationProfileHash:sha('auth'),automationPolicyEvidenceHash:sha('policy'),statusMappingHash:sha('status'),portalConfigurationHash:sha('config'),portalDescriptorHash:sha('descriptor')};
    const subject=buildPortalTargetQualificationSubjectHash(binding);
    const evidence=Object.fromEntries(Object.entries(POLICIES).map(([kind,policy],index)=> {
      if(sandbox && index>=3)return[kind,null];
      const signer=kind==='discovery'?0:kind==='productionAuthorization'?2:1;
      const document=buildPortalTargetQualificationEvidenceAttestation({evidenceType:kind,issuerPrincipalId:authorities[signer].key.subjectId,subjectHash:subject,artifactKind:policy.artifactKind,artifactHash:sha(`artifact:${kind}:${at}`),verificationReceiptKind:policy.verificationReceiptKind,verificationReceiptHash:sha(`receipt:${kind}`),verificationPolicyHash:sha(`policy:${kind}`),verifierRole:policy.authorityRole,evidenceEnvironment:policy.evidenceEnvironment,authorizationScope:policy.authorizationScope,observedAt:new Date(at-60000).toISOString(),expiresAt:new Date(at+2400000).toISOString()});
      return [kind,sign(document,[signer])];
    }));
    return buildPortalTargetQualification({...binding,qualificationLevel:sandbox?'sandbox':'production',qualifiedAt:new Date(at-30000).toISOString(),expiresAt:new Date(at+2400000).toISOString(),evidence});
  }
  function registry(entries,at,prior=null,revoked=[],extra={}) {
    return sign(buildPortalTargetQualificationRegistry({generation:prior?prior.generation+1:1,issuedAt:new Date(at-10000).toISOString(),expiresAt:new Date(at+1200000).toISOString(),entries,predecessorRegistryHash:prior?.portalTargetQualificationRegistryHash||null,revokedQualificationHashes:revoked,...extra}),entries.some(e=>e.productionQualified)?[0,1,2]:[0,1]);
  }
  const current=registry([entry('tmlr',now-100000)],now-100000);
  const candidateEntry=entry('tmlr',now);
  const initial=registry([candidateEntry],now);
  const changed=registry([candidateEntry],now,current,current.entries.map(e=>e.portalTargetQualificationHash));
  const old=registry([entry('tmlr',now-3600000)],now-3600000);
  const cases=[];
  function add(label,candidate,active=null,selectedTrust=trust){
    const text=value=>value?`${JSON.stringify(value,null,2)}\n`:null;
    const candidateText=text(candidate),currentText=text(active),trustText=text(selectedTrust);
    cases.push({label,candidateText,currentText,trustText,candidateHash:hashBytes(Buffer.from(candidateText)),trustHash:hashBytes(Buffer.from(trustText)),registryHash:active?.portalTargetQualificationRegistryHash||null,candidateRegistryHash:candidate.portalTargetQualificationRegistryHash,now:new Date(now).toISOString()});
  }
  add('initial',initial);
  add('sandbox',registry([entry('tmlr',now,true)],now));
  add('two',registry([entry('neurips',now),entry('iclr',now)],now));
  add('empty',registry([],now));
  add('successor-unchanged',registry(current.entries,now,current),current);
  add('successor-replaced',changed,current);
  add('expired-current',registry([candidateEntry],now,old,old.entries.map(e=>e.portalTargetQualificationHash)),old);
  add('missing-revocation',registry([candidateEntry],now,current),current);
  add('unknown-revocation',registry([candidateEntry],now,current,[sha('unknown')]),current);
  add('reused-revocation',registry(current.entries,now,current,current.entries.map(e=>e.portalTargetQualificationHash)),current);
  add('generation-jump',registry([candidateEntry],now,current,current.entries.map(e=>e.portalTargetQualificationHash),{generation:3}),current);
  add('wrong-predecessor',registry([candidateEntry],now,current,current.entries.map(e=>e.portalTargetQualificationHash),{predecessorRegistryHash:sha('wrong')}),current);
  add('initial-generation-two',changed);
  add('subject-route-drift',registry([entry('tmlr',now,false,'new-route')],now,current,current.entries.map(e=>e.portalTargetQualificationHash)),current);
  const tampered=structuredClone(initial);tampered.signatures[0].value='invalid';add('invalid-signature',tampered);
  const revokedTrust=structuredClone(trust);revokedTrust.keys[0].status='revoked';add('revoked-key',initial,null,revokedTrust);
  const malformed=structuredClone(initial);malformed.entries[0].liveCommitAuthorized=true;add('live-authorization-forbidden',malformed);
  return cases;
}
const operations={status:inspectPortalTargetQualificationRegistry,preflight:preflightPortalTargetQualificationRegistry,'import-plan':planPortalTargetQualificationRegistryImport,'import-execute':executePortalTargetQualificationRegistryImport};
const requests=JSON.parse(fs.readFileSync(0,'utf8'));
const results=requests.map(request=>{
  try {
    if(request.operation==='fixtures')return {ok:true,value:fixtures(request.now ? Date.parse(request.now) : Date.now())};
    if(request.operation==='authority-fixtures')return{ok:true,value:qualificationFixtures(Date.parse(request.now))};
    if(request.operation==='cli'){
      const result=runPortalTargetQualificationCli({argv:request.argv,environment:request.environment||{},now:new Date(request.now)});
      return {ok:true,value:result.report||result,exitCode:result.exitCode||0};
    }
    const value=operations[request.operation]({...request.options,now:new Date(request.options.now)});
    return {ok:true,value};
  }catch(error){return{ok:false,error:error.message};}
});
process.stdout.write(`${JSON.stringify({profile:productionOracleProfile(),results})}\n`);
