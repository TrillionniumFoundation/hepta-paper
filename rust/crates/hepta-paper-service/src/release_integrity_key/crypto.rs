use super::{Result, error};
use ed25519_dalek::{
    Signer, SigningKey, VerifyingKey,
    pkcs8::{
        DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey,
        spki::der::pem::LineEnding,
    },
};
use zeroize::Zeroizing;
fn decoding_error(description: &str, private: bool) -> super::ReleaseIntegrityKeyError {
    if description.contains("OID") || description.contains("algorithm") {
        error("release_integrity_key_not_ed25519")
    } else if private {
        error("release_integrity_private_key_encoding_invalid")
    } else {
        error("release_integrity_public_key_encoding_invalid")
    }
}
pub(super) fn validate_pair(private: &[u8], public: &[u8]) -> Result<()> {
    let private_text = std::str::from_utf8(private)
        .map_err(|_| error("release_integrity_private_key_encoding_invalid"))?;
    let public_text = std::str::from_utf8(public)
        .map_err(|_| error("release_integrity_public_key_encoding_invalid"))?;
    let key = SigningKey::from_pkcs8_pem(private_text)
        .map_err(|e| decoding_error(&e.to_string(), true))?;
    let verifier = VerifyingKey::from_public_key_pem(public_text)
        .map_err(|e| decoding_error(&e.to_string(), false))?;
    let derived = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|_| error("release_integrity_key_public_encoding_failed"))?;
    if derived.as_bytes() != public {
        return Err(error("release_integrity_key_pair_mismatch"));
    }
    let mut challenge = [0u8; 64];
    getrandom::fill(&mut challenge)
        .map_err(|_| error("release_integrity_key_randomness_unavailable"))?;
    if verifier
        .verify_strict(&challenge, &key.sign(&challenge))
        .is_err()
    {
        return Err(error("release_integrity_key_pair_self_verification_failed"));
    }
    Ok(())
}
pub(super) fn validate_public(public: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(public)
        .map_err(|_| error("release_integrity_public_key_encoding_invalid"))?;
    VerifyingKey::from_public_key_pem(text).map_err(|e| {
        let selected = decoding_error(&e.to_string(), false);
        if selected.0 == "release_integrity_key_not_ed25519" {
            error("release_integrity_public_key_not_ed25519")
        } else {
            selected
        }
    })?;
    Ok(())
}
pub(super) fn generate() -> Result<(Zeroizing<Vec<u8>>, String)> {
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(seed.as_mut())
        .map_err(|_| error("release_integrity_key_randomness_unavailable"))?;
    let key = SigningKey::from_bytes(&seed);
    let private = key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| error("release_integrity_key_private_encoding_failed"))?;
    let public = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|_| error("release_integrity_key_public_encoding_failed"))?;
    Ok((Zeroizing::new(private.as_bytes().to_vec()), public))
}
