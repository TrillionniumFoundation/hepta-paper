//! Typed command names shared by the actual dispatcher, help and Rust tests.
//! These are Rust entrypoints, not claims of complete Node route parity.
macro_rules! commands {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        /// Closed command vocabulary of the normal Rust executable.
        #[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub enum CommandV1 { $($variant),+ }
        impl CommandV1 {
            /// Every dispatchable command, in stable presentation order.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            /// Exact command-line spelling; aliases are not implicit.
            pub const fn name(self) -> &'static str {
                match self { $(Self::$variant => $name),+ }
            }
            /// Parse a complete name without lossy case or whitespace coercion.
            pub fn parse(name: &str) -> Option<Self> {
                match name { $($name => Some(Self::$variant)),+, _ => None }
            }
        }
    };
}
commands! {
    NativeIdentity => "native-identity",
    Put => "put",
    Run => "run",
    Serve => "serve",
    VerifyLegacyFreeze => "verify-legacy-freeze",
    InspectDb => "inspect-db",
    StoreIntegrity => "store-integrity",
    StoreStatus => "store-status",
    AutomationStatus => "automation-status",
    StoreMigrate => "store-migrate",
    RepositoryAssets => "repository-assets",
    CommandSurface => "command-surface",
    VerifyArchitecture => "verify-architecture",
    VerifyCritical => "verify-critical",
    VerifyFull => "verify-full",
    AdvancedNumericalPlugin => "advanced-numerical-plugin",
    RetirementReference => "retirement-reference",
    RetirementMatrix => "retirement-matrix",
    RetirementDrillAttest => "retirement-drill-attest",
    ReleaseTrustGate => "release-trust-gate",
    ReleaseState => "release-state",
    ReleaseAttest => "release-attest",
    RetirementStatus => "retirement-status",
    RuntimeRSourceCas => "runtime-r-source-cas",
    ResearchReadiness => "research-readiness",
    ExternalAuthorityIntake => "external-authority-intake",
    GenericDomainCapabilityEvidence => "generic-domain-capability-evidence",
    ResearchCapabilityMatrix => "research-capability-matrix",
    LocalGoldenDatasetProvision => "local-golden-dataset-provision",
    AutonomousStateProvision => "autonomous-state-provision",
    AutonomousStatePartialRootMaintenance => "autonomous-state-partial-root-maintenance",
    PersonalGpuOperationalGate => "personal-gpu-operational-gate",
    AutonomousIntakeAuthorityRotation => "autonomous-intake-authority-rotation",
    AutonomousEmpiricalPluginRelease => "autonomous-empirical-plugin-release",
    AutonomousSubmissionDispatcher => "autonomous-submission-dispatcher",
    AutonomousSubmissionDispatcherChallenge => "autonomous-submission-dispatcher-challenge",
    AutonomousResearch => "autonomous-research",
    AutonomousResearchOneShotCampaignAttempt => "autonomous-research-one-shot-campaign-attempt",
    SubmissionHandoffExport => "submission-handoff-export",
    FullProductionReadiness => "full-production-readiness",
    StrictFullAutoAcceptance => "strict-full-auto-acceptance",
    AutonomousSupervisor => "autonomous-supervisor",
    PersonalSelfHostedReadiness => "personal-self-hosted-readiness",
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    #[test]
    fn every_command_roundtrips_and_names_are_unique() {
        let names = CommandV1::ALL
            .iter()
            .map(|command| command.name())
            .collect::<BTreeSet<_>>();
        assert_eq!(names.len(), CommandV1::ALL.len());
        for command in CommandV1::ALL {
            assert_eq!(CommandV1::parse(command.name()), Some(*command));
        }
        for unknown in ["", "RUN", " run", "run ", "run/config", "unknown"] {
            assert_eq!(CommandV1::parse(unknown), None);
        }
    }
    #[test]
    fn canonical_migration_ledger_uses_real_compiled_entrypoints() {
        let ledger: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../docs/migration/node-rust-command-map.v1.json"
        ))
        .unwrap();
        let rows = ledger["commands"].as_array().unwrap();
        assert!(!rows.is_empty());
        let mut seen = BTreeSet::new();
        let mut native_rows = 0;
        for row in rows {
            let id = row["id"].as_str().unwrap();
            assert!(seen.insert(id), "duplicate canonical route: {id}");
            let mut words = row["rustEntrypoint"].as_str().unwrap().split_whitespace();
            if words.next() == Some("hepta-paper-rust") {
                let name = words.next().expect("missing Rust command");
                assert!(
                    CommandV1::parse(name).is_some(),
                    "{id}: unknown command {name}"
                );
                native_rows += 1;
            }
        }
        assert!(
            native_rows > 0,
            "canonical ledger must exercise the normal entrypoint"
        );
    }
}
