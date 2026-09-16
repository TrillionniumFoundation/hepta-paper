// Differential oracle only. Synthetic authority is confined to temporary test
// inputs; no returned fixture is a production qualification or acceptance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildLegacyCapabilityMatrixV3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';

const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const matrix = JSON.parse(fs.readFileSync(new URL('../../migration/legacy-semantic-migration-matrix.json', import.meta.url)));
const initial = buildLegacyCapabilityMatrixV3({ matrixV2: matrix, runtimeRoot: request.root });
const manifest = initial.ownerAcceptanceFamilyManifest;
const pair = crypto.generateKeyPairSync('ed25519');
const signer = { privateKeyPem: pair.privateKey.export({format:'pem',type:'pkcs8'}), keyId:'synthetic-owner', role:'capability_owner' };
let trust = {version:1,kind:'AuthorityTrustStore',keys:[{keyId:signer.keyId,algorithm:'ed25519',status:'active',roles:['capability_owner'],subjectId:'synthetic-owner',assurance:'external_independent',publicKeyPem:pair.publicKey.export({format:'pem',type:'spki'})}]};
let document = {version:2,kind:'CapabilityOwnerAcceptance',familyManifestHash:manifest.familyManifestHash,acceptedAt:'2026-09-16T00:00:00.000Z',acceptedFamilies:manifest.families.map(f=>({familyId:f.familyId,familyHash:f.familyHash,businessDecision:f.businessDecision}))};
const mode = request.mode || 'complete';
if(mode==='version_one' || mode==='wrong_source' || mode==='null_entry') document = {version:1,kind:'CapabilityOwnerAcceptance',acceptedEntries:manifest.families.flatMap(f=>f.legacyEntries.map(e=>({...e,businessDecision:f.businessDecision})))};
if(mode==='null_family') document.acceptedFamilies.push(null);
if(mode==='null_entry') document.acceptedEntries.push(null);
if(mode==='unicode_metadata') document.metadata={'10':'ten','2':'two','é':['δ',null,0,-0,1e-7,1e21], '𝄞':'music', '\uE000':'bmp'};
if(mode==='private_key_zero') trust.keys[0].privateKeyPem=0;
if(mode==='wrong_source') document.acceptedEntries[0].sourceSha256='0'.repeat(64);
if(mode==='wrong_manifest') document.familyManifestHash=`sha256:${'0'.repeat(64)}`;
if(mode==='wrong_family') document.acceptedFamilies[0].familyHash=`sha256:${'0'.repeat(64)}`;
if(mode==='wrong_decision') document.acceptedFamilies[0].businessDecision='capability_reimplementation';
if(mode==='partial') document.acceptedFamilies=document.acceptedFamilies.slice(0,1);
if(mode==='duplicate_family') document.acceptedFamilies.push({...document.acceptedFamilies[0],familyHash:`sha256:${'0'.repeat(64)}`});
if(mode==='local') trust.keys[0].assurance='local_admin_delegated';
if(mode==='unclassified') delete trust.keys[0].assurance;
if(mode==='revoked') trust.keys[0].status='revoked';
if(mode==='wrong_role') trust.keys[0].roles=['operational_observer'];
document=signAuthorityDocument(document,signer);
if(mode==='same_numeric_subject' || mode==='same_object_subject') {
  const second=crypto.generateKeyPairSync('ed25519');
  const subject=mode==='same_numeric_subject'?123:{name:'same principal'};
  trust.keys[0].subjectId=subject;
  trust.keys.push({...trust.keys[0],keyId:'synthetic-second',publicKeyPem:second.publicKey.export({format:'pem',type:'spki'}),subjectId:subject});
  document=signAuthorityDocument(document,{privateKeyPem:second.privateKey.export({format:'pem',type:'pkcs8'}),keyId:'synthetic-second',role:'capability_owner'});
}
if(mode==='signature_unpadded') document.signatures[0].value=document.signatures[0].value.replace(/=+$/,'');
if(mode==='signature_whitespace') document.signatures[0].value=document.signatures[0].value.match(/.{1,16}/g).join(' \n');
if(mode==='signature_urlsafe') document.signatures[0].value=document.signatures[0].value.replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
if(mode==='invalid_pem_unicode_whitespace') trust.keys[0].publicKeyPem=trust.keys[0].publicKeyPem.replace('\n','\n\u00A0');
if(mode==='tamper') document.acceptedAt='2026-09-15T00:00:00.000Z';
if(mode==='bad_signature') document.signatures[0].value=Buffer.alloc(64).toString('base64');
if(mode==='duplicate_key') trust.keys.push({...trust.keys[0]});
if(mode==='private_key') trust.keys[0].privateKeyPem=signer.privateKeyPem;
if(mode==='none') { document=null; trust=null; }
const directory=path.join(request.root,'owner-acceptance');
fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'CAPABILITY_OWNER_ACCEPTANCE.json'),JSON.stringify(document),{mode:0o600});
fs.writeFileSync(path.join(directory,'OWNER_TRUST_STORE.json'),JSON.stringify(trust),{mode:0o600});
const result=buildLegacyCapabilityMatrixV3({matrixV2:matrix,runtimeRoot:request.root});
const s=result.summary;
const complete=s.externallyOwnerAccepted===s.entryCount;
const local=s.localAdminOwnerAccepted===s.entryCount;
const status={version:1,kind:'CapabilityOwnerAcceptanceStatus',status:complete?'external_independent_owner_acceptance_complete':local?'local_admin_delegated_owner_acceptance_complete':'owner_acceptance_pending',familyCount:s.ownerAcceptanceFamilyCount,entryCount:s.entryCount,ownerAccepted:s.ownerAccepted,externallyOwnerAccepted:s.externallyOwnerAccepted,localAdminOwnerAccepted:s.localAdminOwnerAccepted,ownerAcceptancePending:s.ownerAcceptancePending,assurance:complete?'external_independent':local?'local_admin_delegated':'mixed_or_pending',independentExternalAcceptanceComplete:complete,externalSignatureRequiredForIndependentAssurance:true,automaticAcceptanceForbidden:true};
process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu},matrix,manifest,document,trust,status}));
