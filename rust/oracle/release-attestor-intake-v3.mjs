// Tests reuse the original production composition and rotation fixture.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, H } from '../../paper-core/tests/support/research-execution-release-attestor-rotation-fixture.mjs';
import { composeProductionExternalAuthorityIntake } from '../../paper-composition/automation/production-external-authority-intake-composition.mjs';
import { buildAutonomousResearchAuthorIdentityConfiguration } from '../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import { buildExternalPrincipalIdentityAttestationSubject } from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { buildPinnedExternalEvidenceEnvelope, pinnedExternalEvidenceSigningPayload } from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import { hashRecord, hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!input.root?.startsWith('/tmp/hepta-passive-kms-v3-') || !Array.isArray(input.modes) || input.modes.length > 48) throw new Error('private_bounded_fixture_required');
const envKeys = ['PATH','HOME','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','TMP','TEMP','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS',
  'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG','HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH','HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG','HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH'];
for (const key of envKeys) delete process.env[key];
const environment = { PATH: '/nonexistent', TMPDIR: input.root };
Object.assign(process.env, environment);
const now = new Date(input.now);
if (!Number.isFinite(now.getTime())) throw new Error('fixture_clock_invalid');
if (input.operation === 'inspect') {
  const c=input.case;
  if (!c?.releasePath?.startsWith(input.root+'/')) throw new Error('private_fixture_case_required');
  const report=composeProductionExternalAuthorityIntake({authorConfigPath:c.authorPath,authorExpectedConfigurationHash:c.authorHash,
    releaseAttestorConfigPath:c.releasePath,releaseAttestorExpectedConfigurationHash:c.releaseHash,environment:c.environment,now});
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),report}));
  process.exit(0);
}
const results = [];
for (const mode of input.modes) {
  const f = fixture({ after() {} });
  for (const key of f.configuration.trustSet.keys) { key.effectiveFrom='2000-01-01T00:00:00.000Z'; key.expiresAt='2030-01-01T00:00:00.000Z'; }
  f.configuration.backend.probeAttestor.effectiveFrom='2000-01-01T00:00:00.000Z';
  f.configuration.backend.probeAttestor.expiresAt='2030-01-01T00:00:00.000Z';
  f.save();
  const stamp = delta => new Date(now.getTime()+delta).toISOString();
  f.rotateHardwareAuthorityBundle({attestedAt:stamp(-60_000), expiresAt:stamp(300_000)});
  let releasePath=f.configPath;
  const b=f.configuration.backend;
  const bundlePath=f.configuration.hardwareAuthorityAttestation.bundlePath;
  const mutateBundle = callback => {
    const bundle=JSON.parse(fs.readFileSync(bundlePath,'utf8'));callback(bundle);
    const {bundleHash:_hash,...payload}=bundle;
    bundle.bundleHash=hashRecord('ResearchExecutionReleaseKmsHardwareAttestationBundle',payload);
    fs.writeFileSync(bundlePath,JSON.stringify(bundle));fs.chmodSync(bundlePath,0o600);
  };
  if (mode==='expired-hardware') f.rotateHardwareAuthorityBundle({attestedAt:stamp(-540_000),expiresAt:stamp(-60_000)});
  if (mode==='future-hardware') f.rotateHardwareAuthorityBundle({attestedAt:stamp(60_000),expiresAt:stamp(300_000)});
  if (mode==='bad-signature') mutateBundle(bundle=>{bundle.authorityEnvelope.signatures[0].value=Buffer.alloc(64).toString('base64');});
  if (mode==='binding-mismatch') mutateBundle(bundle=>{bundle.subject.backendId='unrelated-backend';const {researchExecutionReleaseKmsHardwareAttestationSubjectHash:_old,...payload}=bundle.subject;
    bundle.subject.researchExecutionReleaseKmsHardwareAttestationSubjectHash=hashRecord('ResearchExecutionReleaseKmsHardwareAttestationSubject',payload);
    bundle.authorityEnvelope.subjectHash=bundle.subject.researchExecutionReleaseKmsHardwareAttestationSubjectHash;});
  if (['authority-key-expired','authority-key-not-effective','authority-key-revoked'].includes(mode)) mutateBundle(bundle=>{
    const key=bundle.trustStore.keys[0];
    if(mode==='authority-key-expired')key.expiresAt=stamp(-120_000);
    if(mode==='authority-key-not-effective')key.effectiveFrom=stamp(1000);
    if(mode==='authority-key-revoked')key.revokedAt=stamp(-120_000);
    bundle.trustStoreHash=hashRecord('PinnedExternalEvidenceTrustStore',bundle.trustStore);
    f.configuration.hardwareAuthorityAttestation.trustStoreHash=bundle.trustStoreHash;
  });
  if (mode==='non-independent-authority') mutateBundle(bundle=>{bundle.trustStore.keys[0].organization='Research Release Office';bundle.trustStoreHash=hashRecord('PinnedExternalEvidenceTrustStore',bundle.trustStore);
    f.configuration.hardwareAuthorityAttestation.trustStoreHash=bundle.trustStoreHash;});
  if (mode==='key-expired' || mode==='key-not-effective') {
    const active=f.configuration.trustSet.keys.find(k=>k.status==='active');
    if (mode==='key-expired') active.expiresAt=stamp(-1000);else active.effectiveFrom=stamp(1000);
    f.save();f.rotateHardwareAuthorityBundle({attestedAt:stamp(-60_000),expiresAt:stamp(300_000)});
  }
  if (mode==='active-revoked') f.configuration.trustSet.keys.find(k=>k.status==='active').revokedAt=stamp(-1000);
  if (mode==='probe-revoked') b.probeAttestor.revokedAt=stamp(-1000);
  if (mode==='probe-same-subject') b.probeAttestor.subjectId='release-attestor';
  if (mode==='probe-same-organization') b.probeAttestor.organization='Research Release Office';
  if (mode==='probe-same-key') b.probeAttestor.publicKeyPath=f.activePublicKeyPath;
  if (mode==='same-credential-root') b.probeCommand.credentialRoot=b.signerCommand.credentialRoot;
  if (mode==='same-executable') b.probeCommand.executable=b.signerCommand.executable;
  if (mode==='credential-public') fs.chmodSync(b.signerCommand.credentialRoot,0o755);
  if (mode==='executable-writable') fs.chmodSync(b.signerCommand.executable,0o722);
  if (mode==='executable-hardlink') fs.linkSync(b.signerCommand.executable,path.join(f.root,'duplicate-executable'));
  if (mode==='invalid-public-key') fs.writeFileSync(f.activePublicKeyPath,'not a public key');
  if (mode==='public-key-private') fs.writeFileSync(f.activePublicKeyPath,'-----BEGIN PRIVATE KEY-----\nfixture\n');
  if (mode==='invalid-timeout') b.signerCommand.timeoutMs=999;
  if (mode==='invalid-protocol') b.signerCommand.protocol='hepta-release-signer-json-stdio-v1';
  if (mode==='command-args') b.signerCommand.args=['--anything'];
  if (mode==='command-environment') b.signerCommand.environmentAllowlist=['PATH'];
  if (mode==='extra-config-field') f.configuration.unexpected=true;
  if (mode==='private-key-disclosure') f.configuration.privateKeyPath='forbidden-private-file';
  if (mode==='wrong-backend') b.kind='local-file';
  if (mode==='trust-pin-mismatch') f.configuration.hardwareAuthorityAttestation.trustStoreHash=H('other-trust');
  if (mode==='challenge-pin-mismatch') f.configuration.hardwareAuthorityAttestation.challengeHash=H('other-challenge');
  if (mode==='signer-pin-mismatch') f.configuration.hardwareAuthorityAttestation.signerKeyIds=['other-hardware-key'];
  if (mode==='reordered-bundle' || mode==='reordered-subject' || mode==='reordered-trust') mutateBundle(bundle=>{
    const reverse=value=>Object.fromEntries(Object.entries(value).reverse());
    if(mode==='reordered-subject')bundle.subject=reverse(bundle.subject);
    if(mode==='reordered-trust')bundle.trustStore=reverse(bundle.trustStore);
    if(mode==='reordered-bundle'){const reversed=reverse(bundle);for(const k of Object.keys(bundle))delete bundle[k];Object.assign(bundle,reversed);}
  });
  if (mode==='missing-bundle') fs.unlinkSync(bundlePath);
  if (mode==='symlink-bundle') {const target=path.join(f.root,'bundle-original');fs.renameSync(bundlePath,target);fs.symlinkSync(target,bundlePath);}
  f.save();
  if (mode==='config-public') fs.chmodSync(f.configPath,0o644);
  if (mode==='config-symlink') {releasePath=path.join(f.root,'config-alias');fs.symlinkSync(f.configPath,releasePath);}
  let expectedHash=f.configurationIdentityHash(environment);
  if(mode==='no-pin')expectedHash=null;
  if(mode==='pin-mismatch')expectedHash=H('wrong-configuration');
  if(mode==='uppercase-pin' && expectedHash)expectedHash=expectedHash.toUpperCase();
  let authorPath=null;let authorHash=null;
  if(mode==='joint-ready') {
    const pair=crypto.generateKeyPairSync('ed25519');const role='external_principal_identity_attestor';
    const subject=buildExternalPrincipalIdentityAttestationSubject({serviceId:'fixture-author-service',principalId:'fixture-author-principal',provider:'openai',
      providerAccountIdentityHash:H('fixture-account'),credentialRootIdentityHash:H('fixture-credential'),hostIdentityHash:H('fixture-host'),processIdentityHash:H('fixture-process'),
      trustDomainIdentityHash:H('fixture-trust-domain'),signerPublicKeySpkiHash:hashBytes(pair.publicKey.export({type:'spki',format:'der'})),challengeHash:H('fixture-author-challenge'),
      assuranceProfile:'pinned-provider-account-and-platform-attestation-v1',attestedAt:stamp(-60_000),expiresAt:stamp(300_000)});
    const placeholder=buildPinnedExternalEvidenceEnvelope({subjectKind:subject.kind,subjectHash:subject.externalPrincipalIdentityAttestationSubjectHash,
      signedAt:stamp(-60_000),expiresAt:stamp(300_000),signatures:[{keyId:'fixture-author-key',role,algorithm:'ed25519',value:'placeholder'}]});
    const envelope=buildPinnedExternalEvidenceEnvelope({...placeholder,signatures:[{keyId:'fixture-author-key',role,algorithm:'ed25519',
      value:crypto.sign(null,pinnedExternalEvidenceSigningPayload(placeholder),pair.privateKey).toString('base64')}]});
    const config=buildAutonomousResearchAuthorIdentityConfiguration({version:2,subject,authorityEnvelope:envelope,
      trustStore:{version:1,kind:'AuthorityTrustStore',keys:[{keyId:'fixture-author-key',subjectId:'fixture-independent-author',organization:'Independent Fixture Author Authority',
        algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),roles:[role],status:'active',effectiveFrom:'2000-01-01T00:00:00.000Z',
        expiresAt:'2030-01-01T00:00:00.000Z',revokedAt:null}]},signerKeyIds:['fixture-author-key'],maximumLifetimeMs:600_000});
    authorPath=path.join(f.root,'author.json');fs.writeFileSync(authorPath,JSON.stringify(config),{mode:0o600});authorHash=config.configurationHash;
  }
  const report=composeProductionExternalAuthorityIntake({authorConfigPath:authorPath,authorExpectedConfigurationHash:authorHash,
    releaseAttestorConfigPath:releasePath,releaseAttestorExpectedConfigurationHash:expectedHash,environment,now});
  if(fs.existsSync(f.unexpectedSpawnPath))throw new Error('passive_fixture_external_process_was_invoked');
  results.push({mode,root:f.root,releasePath,releaseHash:expectedHash,authorPath,authorHash,environment,report});
}
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));
