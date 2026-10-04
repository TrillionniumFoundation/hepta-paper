// Actual original Node calculation; only development differential consumes it.
import fs from 'node:fs';
import { signedPluginFixture, productionQualification } from '../../paper-core/tests/support/advanced-numerical-qualification-fixture.v2.mjs';
import { verifyAdvancedNumericalPluginProductionQualification } from '../../paper-adapters/automation/advanced-numerical-plugin-production-qualification.mjs';
import { verifyAdvancedNumericalPluginSignedBundle } from '../../paper-adapters/automation/out-of-process-advanced-numerical-plugin-runner.mjs';
const f = signedPluginFixture({ gpu: process.argv.includes('--gpu') });
try {
  const q = productionQualification(f), original = { descriptor:f.descriptor, bundleHash:verifyAdvancedNumericalPluginSignedBundle(f.bundle,{trustStore:f.trustStore,now:f.now}).signedBundleHash,
    pluginAuthority:f.bundle.authority, pluginTrust:f.trustStore, statement:q.qualification, evidence:q.evidence, trust:q.trustStore, now:f.now.getTime() };
  const cases=[];
  function sample(label, change, offset=0) {
    const input=structuredClone(original);change(input);
    let expected;
    try {
      const pv=verifyAdvancedNumericalPluginSignedBundle({version:1,kind:'AdvancedNumericalPluginSignedBundle',descriptor:input.descriptor,authority:input.pluginAuthority},{trustStore:input.pluginTrust,now:new Date(input.now)});
      expected={ok:verifyAdvancedNumericalPluginProductionQualification({descriptor:input.descriptor,signedBundleHash:input.bundleHash,
        pluginAuthorityVerification:pv.signatureVerification,pluginTrustStore:input.pluginTrust,qualification:input.statement,
        evidenceBundle:input.evidence,trustStore:input.trust,now:new Date(input.now+offset)})};
    } catch (error) { expected={error:error.message}; }
    input.now+=offset; cases.push({label,input,expected,descriptorRaw:JSON.stringify(input.descriptor)});
  }
  sample('valid-complete-chain',()=>{});
  sample('same-organization',v=>{v.trust.keys[0].organization=v.pluginTrust.keys[0].organization});
  sample('nfkc-organization-collision',v=>{v.trust.keys[0].organization=[...v.pluginTrust.keys[0].organization].map(c=>c.charCodeAt(0)>=33&&c.charCodeAt(0)<=126?String.fromCharCode(c.charCodeAt(0)+0xfee0):c).join('')});
  sample('unicode-organization-normalization',v=>{v.trust.keys[0].organization='  ΩΣ \t Fullwidth ＡＢＣ  '});
  sample('literal-null-organization',v=>{v.trust.keys[0].organization='null'});
  sample('nonbmp-subject-sort',v=>{v.trust.keys[0].subjectId='𐀀';v.trust.keys[1].subjectId='\uE000'});
  sample('same-subject',v=>{v.trust.keys[0].subjectId=v.pluginTrust.keys[0].subjectId});
  sample('revoked-qualification-key',v=>{v.trust.keys[0].status='revoked'});
  sample('qualification-signature-missing',v=>{v.statement.signatures.pop()});
  sample('qualification-signature-tampered',v=>{v.statement.signatures[0].value=Buffer.alloc(64).toString('base64')});
  sample('qualification-role-not-trusted',v=>{v.trust.keys[0].roles=['different_role']});
  sample('duplicate-trust-key',v=>{v.trust.keys.push(structuredClone(v.trust.keys[0]))});
  sample('same-public-key',v=>{v.trust.keys[0].publicKeyPem=v.trust.keys[1].publicKeyPem});
  sample('evidence-receipt-digest-tampered',v=>{v.evidence.referenceExecutionReceipt.resultHash='sha256:'+ '1'.repeat(64)});
  sample('statement-digest-tampered',v=>{v.statement.evidence.referenceResultHash='sha256:'+ '1'.repeat(64)});
  sample('statement-unknown-field',v=>{v.statement.unknown='x'});
  sample('evidence-unknown-field',v=>{v.evidence.unknown='x'});
  sample('qualification-not-yet-valid',()=>{},-40_000);
  sample('qualification-expired',()=>{},60_000);
  sample('nonbmp-untrusted-key-blocker-sort',v=>{v.statement.signatures[0].keyId='𐀀';v.statement.signatures[1].keyId='\uE000'});
  sample('bad-qualification-key-pem',v=>{v.trust.keys[0].publicKeyPem='not a key'});
  process.stdout.write(JSON.stringify(cases)+'\n');
} finally { fs.rmSync(f.root,{recursive:true,force:false}); }

