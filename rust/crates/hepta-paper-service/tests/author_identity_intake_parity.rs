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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildAutonomousResearchAuthorIdentityConfiguration } from './paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import { buildPinnedExternalEvidenceEnvelope, pinnedExternalEvidenceSigningPayload } from './paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import { buildExternalPrincipalIdentityAttestationSubject } from './paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { composeProductionExternalAuthorityIntake } from './paper-composition/automation/production-external-authority-intake-composition.mjs';
const root = process.argv[1]; const mode = process.argv[2]; const now = new Date(process.argv[3]);
const file = path.join(root, 'author.json'); const H = value => crypto.createHash('sha256').update(value).digest('hex').replace(/^/, 'sha256:');
if (mode === 'malformed') { fs.writeFileSync(file, '{}', { mode: 0o600 }); }
else {
  const pair = crypto.generateKeyPairSync('ed25519'); const role = 'external_principal_identity_attestor';
  const subject = buildExternalPrincipalIdentityAttestationSubject({serviceId:'external-author-platform',principalId:'external-author-principal',provider:'openai',providerAccountIdentityHash:H('account'),credentialRootIdentityHash:H('credential'),hostIdentityHash:H('host'),processIdentityHash:H('process'),trustDomainIdentityHash:H('domain'),signerPublicKeySpkiHash:H('signer'),challengeHash:H('challenge'),assuranceProfile:'pinned-provider-account-and-platform-attestation-v1',attestedAt:mode === 'expired' ? '2026-07-29T03:40:00.000Z' : '2026-07-29T03:58:00.000Z',expiresAt:mode === 'expired' ? '2026-07-29T03:50:00.000Z' : '2026-07-29T04:08:00.000Z'});
  const unsigned = buildPinnedExternalEvidenceEnvelope({subjectKind:subject.kind,subjectHash:subject.externalPrincipalIdentityAttestationSubjectHash,signedAt:'2026-07-29T03:59:00.000Z',expiresAt:'2026-07-29T04:05:00.000Z',signatures:[{keyId:'author-key',role,algorithm:'ed25519',value:'placeholder'}]});
  const signature = mode === 'bad-signature' ? Buffer.alloc(64).toString('base64') : crypto.sign(null,pinnedExternalEvidenceSigningPayload(unsigned),pair.privateKey).toString('base64');
  const configuration = buildAutonomousResearchAuthorIdentityConfiguration({version:2,subject,authorityEnvelope:buildPinnedExternalEvidenceEnvelope({...unsigned,signatures:[{keyId:'author-key',role,algorithm:'ed25519',value:signature}]}),trustStore:{version:1,kind:'AuthorityTrustStore',keys:[{keyId:'author-key',subjectId:'author-authority',organization:'Independent Author Identity Authority',algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),roles:[role],status:'active',effectiveFrom:'2026-07-29T00:00:00.000Z',expiresAt:'2026-07-30T00:00:00.000Z',revokedAt:null}]},signerKeyIds:['author-key'],maximumLifetimeMs:10 * 60 * 1000});
  fs.writeFileSync(file, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
const report = composeProductionExternalAuthorityIntake({authorConfigPath:file,authorExpectedConfigurationHash:null,releaseAttestorConfigPath:null,environment:{},now});
process.stdout.write(JSON.stringify({path:file,author:report.author}));
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
    for mode in ["valid", "expired", "bad-signature", "malformed"] {
        let root = std::env::temp_dir().join(format!(
            "hepta-author-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root)?;
        let node = node_case(&root, mode)?;
        let rust = inspect_external_authority_intake_v1(
            Some(Path::new(node["path"].as_str().unwrap())),
            None,
            None,
            None,
            NOW,
        )?;
        assert_eq!(rust["author"], node["author"], "case {mode}");
        fs::remove_dir_all(root)?;
    }
    Ok(())
}
