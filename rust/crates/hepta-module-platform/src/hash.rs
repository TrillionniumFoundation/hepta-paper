use hepta_codex_protocol::Sha256Digest;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ModulePlatformError;

pub(crate) fn canonical_hash<T: Serialize + ?Sized>(
    value: &T,
) -> Result<Sha256Digest, ModulePlatformError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ModulePlatformError::EncodingInvalid)?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
        .parse()
        .map_err(|_| ModulePlatformError::EncodingInvalid)
}
