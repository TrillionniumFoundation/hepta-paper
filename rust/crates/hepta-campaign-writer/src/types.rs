use serde::{Deserialize, Serialize};

use crate::CampaignWriterError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriterAuthorityV1 {
    pub generation: u64,
    pub token: String,
}

impl WriterAuthorityV1 {
    pub fn new(generation: u64, token: impl Into<String>) -> Result<Self, CampaignWriterError> {
        let token = token.into();
        if generation == 0 || !valid_identifier(&token) {
            return Err(CampaignWriterError::InvalidAuthority);
        }
        Ok(Self { generation, token })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStateV1 {
    Ready,
    Claimed,
    Prepared,
    Completed,
    FailedPreProvider,
    Ambiguous,
}

impl NodeStateV1 {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Claimed => "claimed",
            Self::Prepared => "prepared",
            Self::Completed => "completed",
            Self::FailedPreProvider => "failed_pre_provider",
            Self::Ambiguous => "ambiguous",
        }
    }

    pub(crate) fn from_str(value: &str) -> Result<Self, CampaignWriterError> {
        match value {
            "ready" => Ok(Self::Ready),
            "claimed" => Ok(Self::Claimed),
            "prepared" => Ok(Self::Prepared),
            "completed" => Ok(Self::Completed),
            "failed_pre_provider" => Ok(Self::FailedPreProvider),
            "ambiguous" => Ok(Self::Ambiguous),
            _ => Err(CampaignWriterError::CorruptValue("node_state")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeClaimV1 {
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub claim_owner: String,
    pub campaign_revision: u64,
    pub lease_generation: u64,
    pub deadline_unix_ms: u64,
    pub reserved_microusd: u64,
    pub reserved_cpu_jobs: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedNodeResultV1 {
    pub claim: NodeClaimV1,
    pub prepared_receipt_hash: String,
    pub provider_action_may_have_started: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CampaignStatusV1 {
    pub campaign_id: String,
    pub revision: u64,
    pub budget_remaining_microusd: u64,
    pub cpu_jobs_remaining: u32,
    pub completed_nodes: u64,
    pub ambiguous_nodes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeStatusV1 {
    pub campaign_id: String,
    pub node_id: String,
    pub state: NodeStateV1,
    pub lease_generation: u64,
    pub attempt_id: Option<String>,
    pub prepared_receipt_hash: Option<String>,
    pub integrated_result_hash: Option<String>,
    pub provider_action_may_have_started: bool,
}

pub(crate) fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 160 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
        })
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}
