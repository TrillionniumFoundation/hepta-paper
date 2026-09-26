//! Installed broker daemon composition for one role-specific Codex product.
//!
//! The configuration is an authority-owned, broker-readable document. It contains
//! public verification material and paths only; provider credentials remain in the
//! broker-owned Codex home and are observed by runtime identity rather than copied
//! into configuration or logs.

mod compose;
mod config;

#[cfg(test)]
mod tests;

use thiserror::Error;

pub use compose::{compose_product_codex_broker, run_product_codex_broker};
pub use config::{
    LoadedProductCodexBrokerConfigurationV1, ProductBundleAuthorityKeyV1,
    ProductCgroupConfigurationV1, ProductCodexBrokerConfigurationIdentityV1,
    ProductCodexBrokerConfigurationV1, ProductJournalConfigurationV1,
    ProductListenerConfigurationV1, ProductProcessLimitsConfigurationV1,
    ProductRuntimeConfigurationV1, ProductServerConfigurationV1,
    load_product_codex_broker_configuration,
};

#[derive(Debug, Error)]
pub enum ProductCodexBrokerDaemonError {
    #[error("broker configuration path is not canonical and absolute")]
    ConfigurationPath,
    #[error("broker configuration file shape or permissions are invalid")]
    ConfigurationFile,
    #[error("broker configuration JSON is invalid")]
    ConfigurationJson,
    #[error("broker configuration changed while being read")]
    ConfigurationChanged,
    #[error("broker configuration authority does not match the file installation")]
    ConfigurationAuthority,
    #[error("broker configuration policy is invalid")]
    ConfigurationPolicy,
    #[error("current process is not the configured broker principal")]
    BrokerPrincipal,
    #[error("trust-bundle authority keys are invalid")]
    AuthorityKeys,
    #[error("restricted broker environment is invalid")]
    Environment,
    #[error("digest construction failed")]
    Digest,
    #[error("filesystem failure at {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error(transparent)]
    RuntimeIdentity(#[from] hepta_codex_runtime::RuntimeIdentityError),
    #[error(transparent)]
    Product(#[from] crate::ProductCodexError),
    #[error(transparent)]
    TrustSource(#[from] crate::TrustBundleSourceError),
    #[error(transparent)]
    TrustBundle(#[from] crate::TrustBundleError),
    #[error(transparent)]
    Peer(#[from] crate::PeerAuthorizationError),
    #[error(transparent)]
    Journal(#[from] crate::BrokerJournalError),
    #[error(transparent)]
    Listener(#[from] crate::BrokerListenerError),
    #[error(transparent)]
    Server(#[from] crate::BrokerServerError),
}
