//! Differential cases for the passive author-identity verifier.

use hepta_paper_service::external_authority_intake::inspect_external_authority_intake_v1;
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const NOW: &str = "2026-07-29T04:00:00.000Z";
static NEXT: AtomicU64 = AtomicU64::new(0);

fn node_case(root: &Path, mode: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let source = r#"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildAutonomousResearchAuthorIdentityConfiguration } from './paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import { buildPinnedExternalEvidenceEnvelope, pinnedExternalEvidenceSigningPayload } from './paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import { buildExternalPrincipalIdentityAttestationSubject } from './paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { composeProductionExternalAuthorityIntake } from './paper-composition/automation/production-external-authority-intake-composition.mjs';
import { hashRecord } from './workflow-kernel/record-hash.mjs';
const root = process.argv[1]; const mode = process.argv[2]; const now = new Date(process.argv[3]);
const file = path.join(root, 'author.json');
const H = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const reverseKeys = value => Object.fromEntries(Object.entries(value).reverse());
const rehashConfiguration = configuration => {
  const {configurationHash: _previous, ...payload} = configuration;
  return {...payload, configurationHash: hashRecord('AutonomousResearchAuthorIdentityConfiguration', payload)};
};
let expectedHash = null;
if (mode === 'malformed') { fs.writeFileSync(file, '{}', { mode: 0o600 }); }
else {
  // Ephemeral keys are test fixtures only. The composition performs no external action.
  const role = 'external_principal_identity_attestor';
  const multiKey = mode === 'multi-key-locale-order' || mode === 'signer-binding';
  const keyIds = multiKey ? ['A', 'a', 'a-b', 'a_b']
    : [mode === 'numeric-signature-key-id' ? '42' : 'author-key'];
  const pairs = keyIds.map(keyId => ({keyId, pair: crypto.generateKeyPairSync('ed25519')}));
  const expired = mode === 'expired' || mode === 'v1-expired';
  const subject = buildExternalPrincipalIdentityAttestationSubject({
    serviceId:'external-author-platform',principalId:'external-author-principal',provider:'openai',
    providerAccountIdentityHash:H('account'),credentialRootIdentityHash:H('credential'),
    hostIdentityHash:H('host'),processIdentityHash:H('process'),trustDomainIdentityHash:H('domain'),
    signerPublicKeySpkiHash:H('signer'),challengeHash:H('challenge'),
    assuranceProfile:'pinned-provider-account-and-platform-attestation-v1',
    attestedAt:expired ? '2026-07-29T03:40:00.000Z' : '2026-07-29T03:58:00.000Z',
    expiresAt:expired ? '2026-07-29T03:50:00.000Z' : '2026-07-29T04:08:00.000Z',
  });
  const makeEnvelope = subjectValue => {
    const unsigned = buildPinnedExternalEvidenceEnvelope({
      subjectKind:subjectValue.kind,subjectHash:subjectValue.externalPrincipalIdentityAttestationSubjectHash,
      signedAt:'2026-07-29T03:59:00.000Z',expiresAt:'2026-07-29T04:05:00.000Z',
      signatures:[{keyId:keyIds[0],role,algorithm:'ed25519',value:'placeholder'}],
    });
    const signers = mode === 'signer-binding' ? pairs.slice(0, 1) : pairs;
    const signatures = signers.map(({keyId, pair}) => ({
      keyId:mode === 'numeric-signature-key-id' ? 42 : keyId,role,algorithm:'ed25519',
      value:mode === 'bad-signature' ? Buffer.alloc(64).toString('base64')
        : crypto.sign(null,pinnedExternalEvidenceSigningPayload(unsigned),pair.privateKey).toString('base64'),
    }));
    return buildPinnedExternalEvidenceEnvelope({...unsigned,signatures});
  };
  let configuration = structuredClone(buildAutonomousResearchAuthorIdentityConfiguration({
    version:mode === 'v1-expired' || mode === 'invalid-version' ? 1 : 2,
    subject,authorityEnvelope:makeEnvelope(subject),
    trustStore:{version:1,kind:'AuthorityTrustStore',keys:pairs.map(({keyId,pair}) => ({
      keyId,subjectId:`author-authority-${keyId}`,organization:'Independent Author Identity Authority',
      algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),roles:[role],
      status:'active',effectiveFrom:'2026-07-29T00:00:00.000Z',expiresAt:'2026-07-30T00:00:00.000Z',revokedAt:null,
    }))},
    signerKeyIds:keyIds,maximumLifetimeMs:10 * 60 * 1000,
  }));
  if (mode === 'invalid-version') configuration.version = 3;
  if (mode === 'non-platform-subject') {
    configuration.subject = buildExternalPrincipalIdentityAttestationSubject({
      ...subject,assuranceProfile:'operator-attested-external-principal-v1',
    });
    configuration.authorityEnvelope = makeEnvelope(configuration.subject);
    configuration.identityPolicy.assuranceProfile = configuration.subject.assuranceProfile;
  }
  if (mode === 'overlong-configured-lifetime') configuration.maximumLifetimeMs = 24 * 60 * 60 * 1000 + 1;
  if (mode === 'subject-exceeds-configured-lifetime') configuration.maximumLifetimeMs = 9 * 60 * 1000;
  if (mode === 'malformed-organization') configuration.trustStore.keys[0].organization = {unexpected:true};
  if (mode === 'key-not-effective') configuration.trustStore.keys[0].effectiveFrom = '2026-07-29T03:59:30.000Z';
  if (mode === 'key-expired') configuration.trustStore.keys[0].expiresAt = '2026-07-29T03:58:30.000Z';
  if (mode === 'key-revoked') configuration.trustStore.keys[0].revokedAt = '2026-07-29T03:58:30.000Z';
  if (mode === 'reordered-top') configuration = reverseKeys(configuration);
  if (mode === 'reordered-subject') configuration.subject = reverseKeys(configuration.subject);
  if (mode === 'reordered-policy') configuration.identityPolicy = reverseKeys(configuration.identityPolicy);
  if (mode === 'reordered-trust') configuration.trustStore = reverseKeys(configuration.trustStore);
  if (mode === 'reordered-trust-key') configuration.trustStore.keys[0] = reverseKeys(configuration.trustStore.keys[0]);
  if (mode === 'reordered-envelope') configuration.authorityEnvelope = reverseKeys(configuration.authorityEnvelope);
  if (mode === 'reordered-signature') configuration.authorityEnvelope.signatures[0] = reverseKeys(configuration.authorityEnvelope.signatures[0]);
  // Keep integrity pins correct so each negative case reaches its semantic guard.
  configuration.trustStoreHash = hashRecord('PinnedExternalEvidenceTrustStore', configuration.trustStore);
  configuration = rehashConfiguration(configuration);
  expectedHash = ['valid', 'expired', 'v1-expired'].includes(mode) ? null : configuration.configurationHash;
  if (mode === 'pin-mismatch') expectedHash = H('different-configuration');
  if (mode === 'uppercase-pin') expectedHash = expectedHash.toUpperCase();
  fs.writeFileSync(file, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
const report = composeProductionExternalAuthorityIntake({authorConfigPath:file,authorExpectedConfigurationHash:expectedHash,releaseAttestorConfigPath:null,environment:{},now});
const author = report.author;
const invalidConfiguration = ['malformed','invalid-version','non-platform-subject','overlong-configured-lifetime',
  'subject-exceeds-configured-lifetime','malformed-organization','reordered-top','reordered-subject',
  'reordered-policy','reordered-trust','reordered-trust-key','reordered-envelope'].includes(mode);
assert.equal(author.configured, !invalidConfiguration, `fixture ${mode} configured`);
const readyCases = ['valid-pinned','uppercase-pin','reordered-signature','numeric-signature-key-id','multi-key-locale-order'];
assert.equal(author.readyForRuntimeBinding, readyCases.includes(mode), `fixture ${mode} readiness`);
assert.equal(author.externalActionPerformed, false);
if (invalidConfiguration) assert.deepEqual(author.blockers, ['autonomous_research_author_identity_configuration_verification_failed']);
if (mode === 'v1-expired') assert.deepEqual(author.blockers, [
  'autonomous_research_author_identity_configuration_pin_required',
  'autonomous_research_author_identity_stable_policy_v2_required',
  'autonomous_research_author_identity_subject_not_current',
]);
if (mode.startsWith('key-')) assert.deepEqual(author.blockers, ['pinned_external_evidence_signer_outside_key_time_window']);
if (mode === 'signer-binding') assert.deepEqual(author.blockers, ['pinned_external_evidence_signer_key_binding_invalid']);
if (mode === 'bad-signature') assert.deepEqual(author.blockers, ['immutable_signed_json_authority_signature_invalid']);
process.stdout.write(JSON.stringify({path:file,expectedHash,author}));
"#;
    let output = Command::new("node")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .args([
            "--input-type=module",
            "--eval",
            source,
            root.to_str().unwrap(),
            mode,
            NOW,
        ])
        .output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string().into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[test]
fn author_inputs_match_node_for_valid_expired_bad_signature_and_malformed_cases()
-> Result<(), Box<dyn std::error::Error>> {
    let mut mismatches = Vec::new();
    for mode in [
        "valid",
        "valid-pinned",
        "uppercase-pin",
        "pin-mismatch",
        "expired",
        "v1-expired",
        "bad-signature",
        "malformed",
        "invalid-version",
        "non-platform-subject",
        "overlong-configured-lifetime",
        "subject-exceeds-configured-lifetime",
        "malformed-organization",
        "reordered-top",
        "reordered-subject",
        "reordered-policy",
        "reordered-trust",
        "reordered-trust-key",
        "reordered-envelope",
        "reordered-signature",
        "numeric-signature-key-id",
        "key-not-effective",
        "key-expired",
        "key-revoked",
        "signer-binding",
        "multi-key-locale-order",
    ] {
        let root = std::env::temp_dir().join(format!(
            "hepta-author-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root)?;
        let node = node_case(&root, mode)?;
        let rust = inspect_external_authority_intake_v1(
            Some(Path::new(node["path"].as_str().unwrap())),
            node["expectedHash"].as_str(),
            None,
            None,
            NOW,
        )?;
        if rust["author"] != node["author"] {
            mismatches.push(format!(
                "case {mode}:\nRust: {}\nNode: {}",
                rust["author"], node["author"]
            ));
        }
        fs::remove_dir_all(root)?;
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n\n"));
    Ok(())
}
