//! Durable, non-authorizing binding between a local workflow and an opaque
//! restricted-research qualification.

use std::str::FromStr;

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ActivationStateV1;
use hepta_qualification_ingest::{
    QualificationClosureError, VerifiedResearchQualificationV3,
    qualification_closure::{
        ResearchQualificationExpectationV3, ResearchWorkflowProfileTemplateV1,
    },
};
use serde::{Deserialize, Serialize};

/// Research activation is private state only and never release/submission authority.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchActivationStageV1 {
    /// Bounded research canary.
    Canary,
    /// Current research-state implementation, never a production/release grant.
    Established,
}

impl ResearchActivationStageV1 {
    pub(crate) const fn module_activation(self) -> ActivationStateV1 {
        match self {
            Self::Canary => ActivationStateV1::Canary,
            Self::Established => ActivationStateV1::Authoritative,
        }
    }
}

/// Persisted identity requirements for a research-qualified local workflow.
/// This record is not authority: every dispatch must present the matching opaque
/// qualification and recheck its currentness.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchWorkflowProfileV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Canary or established private research state.
    pub stage: ResearchActivationStageV1,
    /// Exact repository subject.
    pub repository: String,
    /// Exact source commit.
    pub commit: String,
    /// Exact source tree.
    pub tree: String,
    /// Stable domain-separated opaque research evidence binding.
    pub qualification_binding_hash: Sha256Digest,
    /// Exact accepted trust-store generation.
    pub qualification_trust_store_generation: u64,
    /// First invalid millisecond of the retained evidence set.
    pub qualification_expires_at_unix_ms: u64,
    /// Runtime identity agreed by the independently signed role package.
    pub qualified_codex_runtime_identity_hash: Sha256Digest,
    /// Research qualification never activates the workflow automatically.
    pub automatic_activation: bool,
    /// Research qualification never grants production activation.
    pub production_activation: bool,
    /// Research qualification never grants release authority.
    pub release_authority: bool,
    /// Research qualification never grants submission authority.
    pub submission_authority: bool,
}

impl ResearchWorkflowProfileV1 {
    /// Bind a workflow to an already verified opaque qualification.
    pub fn from_qualification(
        stage: ResearchActivationStageV1,
        qualification: &VerifiedResearchQualificationV3,
    ) -> Result<Self, QualificationClosureError> {
        let subject = qualification.subject();
        let qualification_binding_hash = Sha256Digest::from_str(qualification.binding_hash())
            .map_err(|_| QualificationClosureError::SubjectInvalid)?;
        let qualified_codex_runtime_identity_hash =
            Sha256Digest::from_str(&qualification.runtime_facts().codex_runtime_identity_hash)
                .map_err(|_| QualificationClosureError::PayloadFactsInvalid)?;
        Ok(Self {
            version: 1,
            stage,
            repository: subject.repository.clone(),
            commit: subject.commit.clone(),
            tree: subject.tree.clone(),
            qualification_binding_hash,
            qualification_trust_store_generation: qualification.trust_store_generation(),
            qualification_expires_at_unix_ms: qualification.expires_at_unix_ms(),
            qualified_codex_runtime_identity_hash,
            automatic_activation: false,
            production_activation: false,
            release_authority: false,
            submission_authority: false,
        })
    }

    /// Construct the exact least-authorizing profile emitted by the canonical
    /// V3 closure receipt. The template is directly serializable but remains
    /// non-authorizing; advancing still requires the matching opaque value.
    pub fn from_template(
        template: &ResearchWorkflowProfileTemplateV1,
    ) -> Result<Self, QualificationClosureError> {
        if template.version != 1
            || template.stage != "canary"
            || template.automatic_activation
            || template.production_activation
            || template.release_authority
            || template.submission_authority
        {
            return Err(QualificationClosureError::SubjectInvalid);
        }
        let qualification_binding_hash =
            Sha256Digest::from_str(&template.qualification_binding_hash)
                .map_err(|_| QualificationClosureError::SubjectInvalid)?;
        let qualified_codex_runtime_identity_hash =
            Sha256Digest::from_str(&template.qualified_codex_runtime_identity_hash)
                .map_err(|_| QualificationClosureError::PayloadFactsInvalid)?;
        let profile = Self {
            version: template.version,
            stage: ResearchActivationStageV1::Canary,
            repository: template.repository.clone(),
            commit: template.commit.clone(),
            tree: template.tree.clone(),
            qualification_binding_hash,
            qualification_trust_store_generation: template.qualification_trust_store_generation,
            qualification_expires_at_unix_ms: template.qualification_expires_at_unix_ms,
            qualified_codex_runtime_identity_hash,
            automatic_activation: template.automatic_activation,
            production_activation: template.production_activation,
            release_authority: template.release_authority,
            submission_authority: template.submission_authority,
        };
        if !profile.is_well_formed() {
            return Err(QualificationClosureError::SubjectInvalid);
        }
        Ok(profile)
    }

    /// Exact expectation used by the file verifier before replay-ledger mutation.
    #[must_use]
    pub fn qualification_expectation(&self) -> ResearchQualificationExpectationV3 {
        ResearchQualificationExpectationV3 {
            subject: hepta_qualification_ingest::ExternalQualificationClosureSubjectV1 {
                repository: self.repository.clone(),
                commit: self.commit.clone(),
                tree: self.tree.clone(),
            },
            qualification_binding_hash: self.qualification_binding_hash.to_string(),
            qualification_trust_store_generation: self.qualification_trust_store_generation,
            qualification_expires_at_unix_ms: self.qualification_expires_at_unix_ms,
            qualified_codex_runtime_identity_hash: self
                .qualified_codex_runtime_identity_hash
                .to_string(),
        }
    }

    /// Pure shape validation; authority remains in the opaque qualification.
    #[must_use]
    pub fn is_well_formed(&self) -> bool {
        self.version == 1
            && self.repository == "TrillionniumFoundation/hepta-paper"
            && valid_git_hash(&self.commit)
            && valid_git_hash(&self.tree)
            && self.qualification_trust_store_generation > 0
            && self.qualification_trust_store_generation <= i64::MAX as u64
            && self.qualification_expires_at_unix_ms > 0
            && self.qualification_expires_at_unix_ms <= i64::MAX as u64
            && !self.automatic_activation
            && !self.production_activation
            && !self.release_authority
            && !self.submission_authority
    }

    /// Recheck exact identity and currentness before a dispatch boundary.
    pub fn assert_qualification(
        &self,
        qualification: &VerifiedResearchQualificationV3,
        now_unix_ms: u64,
    ) -> Result<(), QualificationClosureError> {
        qualification.assert_current(now_unix_ms)?;
        let actual = Self::from_qualification(self.stage, qualification)?;
        if actual != *self {
            return Err(QualificationClosureError::SubjectInvalid);
        }
        Ok(())
    }
}

fn valid_git_hash(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
