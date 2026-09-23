//! Actual signed seven-package factory regressions at deterministic time
//! boundaries. Fixture signatures never supply independent host acceptance.

use super::*;
use hepta_qualification_ingest::{
    ExternalQualificationClosureSubjectV1, VerifiedExternalQualificationClosureV1,
    verify_external_qualification_closure_v1,
};

fn closure(
    signed: &SignedPackages,
    now: u64,
) -> Result<VerifiedExternalQualificationClosureV1, QualificationClosureError> {
    verify_external_qualification_closure_v1(
        &signed.candidates,
        &ExternalQualificationClosureSubjectV1 {
            repository: REQUIRED_REPOSITORY.into(),
            commit: COMMIT.into(),
            tree: TREE.into(),
        },
        now,
        1,
        &signed.trust,
    )
}

pub(super) fn expire_payload(signed: &mut SignedPackages, index: usize, timestamp: &str) {
    signed.update_payload(index, |payload| {
        payload["expiresAt"] = json!(timestamp);
        if index == 6 {
            sign_authority_set(payload);
        }
    });
}

pub(super) fn expire_inner(signed: &mut SignedPackages, index: usize, timestamp: &str) {
    signed.update_payload(6, |payload| {
        let subject = payload["subjectHash"]
            .as_str()
            .expect("set subject")
            .to_owned();
        let receipt = &mut payload["receipts"][index];
        receipt["expiresAt"] = json!(timestamp);
        let message = authority_receipt_signing_bytes_v1(&subject, receipt)
            .expect("changed inner signing bytes");
        receipt["signatureBase64"] = json!(Base64UrlUnpadded::encode_string(
            &SigningKey::from_bytes(&[INNER_AUTHORITIES[index].3; 32])
                .sign(&message)
                .to_bytes()
        ));
        sign_authority_set(payload);
    });
}

#[test]
fn every_signed_payload_limits_the_opaque_window_before_its_outer_envelope_expires() {
    for index in 0..QualificationPackageIdV1::ALL.len() {
        let mut signed = SignedPackages::new();
        expire_payload(&mut signed, index, "2026-08-30T12:00:01.0005Z");
        signed.assert_individually_valid();
        let verified = closure(&signed, NOW).expect("actual seven signed packages");
        assert_eq!(
            verified.expires_at_unix_ms(),
            NOW + 1_001,
            "package {index}"
        );
        assert!(verified.assert_current(NOW + 1_000).is_ok());
        assert!(matches!(
            verified.assert_current(NOW + 1_001),
            Err(QualificationClosureError::ClosureExpired)
        ));
        assert!(matches!(
            verified.assert_current(NOW - 1),
            Err(QualificationClosureError::ClosureExpired)
        ));
        // The retained opaque window agrees with genuinely re-running the
        // signature/payload factory at the two adjacent integer clock samples.
        assert!(closure(&signed, NOW + 1_000).is_ok());
        assert!(matches!(
            closure(&signed, NOW + 1_001),
            Err(QualificationClosureError::Payload(
                QualificationPayloadError::SemanticInvalid
            ))
        ));
    }
}

#[test]
fn every_required_inner_authority_signature_limits_the_opaque_window() {
    for index in 0..INNER_AUTHORITIES.len() {
        let mut signed = SignedPackages::new();
        expire_inner(&mut signed, index, "2026-08-30T12:00:00.1005Z");
        signed.assert_individually_valid();
        let verified = closure(&signed, NOW).expect("genuinely re-signed inner/set/envelope");
        assert_eq!(verified.expires_at_unix_ms(), NOW + 101, "inner {index}");
        assert!(verified.assert_current(NOW + 100).is_ok());
        assert!(matches!(
            verified.assert_current(NOW + 101),
            Err(QualificationClosureError::ClosureExpired)
        ));
        assert!(closure(&signed, NOW + 100).is_ok());
        assert!(matches!(
            closure(&signed, NOW + 101),
            Err(QualificationClosureError::Payload(
                QualificationPayloadError::SemanticInvalid
            ))
        ));
    }
}

#[test]
fn earlier_outer_envelope_still_wins_over_all_valid_inner_windows() {
    let mut signed = SignedPackages::new();
    expire_inner(&mut signed, 2, "2026-08-30T12:00:00.9005Z");
    signed.candidates[4].envelope.expires_at_unix_ms = NOW + 700;
    resign_envelope(&mut signed.candidates[4], 4);
    signed.assert_individually_valid();
    let verified = closure(&signed, NOW).expect("valid complete closure");
    assert_eq!(verified.expires_at_unix_ms(), NOW + 700);
    assert!(verified.assert_current(NOW + 699).is_ok());
    assert!(matches!(
        verified.assert_current(NOW + 700),
        Err(QualificationClosureError::ClosureExpired)
    ));
}

#[test]
fn exact_millisecond_and_submillisecond_payload_expiries_match_fresh_validation() {
    for (timestamp, last_valid, first_invalid) in [
        ("2026-08-30T12:00:00.100000000Z", 99, 100),
        ("2026-08-30T12:00:00.100000001Z", 100, 101),
        ("2026-08-30T12:00:00.999999999Z", 999, 1_000),
        ("2026-08-30T12:00:01Z", 999, 1_000),
    ] {
        let mut signed = SignedPackages::new();
        expire_payload(&mut signed, 0, timestamp);
        let verified = closure(&signed, NOW).expect("valid signed fractional boundary");
        assert_eq!(verified.expires_at_unix_ms(), NOW + first_invalid);
        assert!(verified.assert_current(NOW + last_valid).is_ok());
        assert!(closure(&signed, NOW + last_valid).is_ok());
        assert!(verified.assert_current(NOW + first_invalid).is_err());
        assert!(closure(&signed, NOW + first_invalid).is_err());
    }
}

#[test]
fn narrowed_window_keeps_cli_report_and_exact_replay_bytes_but_refuses_expired_acceptance() {
    let mut fixture = AcceptanceFixture::new("joint-inner-window");
    expire_inner(&mut fixture.signed, 0, "2026-08-30T12:00:00.1005Z");
    fixture.signed.assert_individually_valid();
    let expected = legacy_receipt_bytes(&fixture.signed);
    let receipt = fixture
        .accept(NOW)
        .expect("actual joint verification and ledger commit");
    assert_eq!(serde_json::to_vec(&receipt).expect("report"), expected);
    let initial = fixture.snapshot();
    assert_eq!(initial[2].1.len(), 1);
    assert_eq!(initial[3].1.len(), 7);
    let replay = fixture.accept(NOW + 100).expect("still valid exact replay");
    assert_eq!(
        serde_json::to_vec(&replay).expect("replayed report"),
        expected
    );
    let before_expired = fixture.snapshot();
    assert_eq!(before_expired[2], initial[2]);
    assert_eq!(before_expired[3], initial[3]);
    assert!(matches!(
        fixture.accept(NOW + 101),
        Err(ClosureError::Payload(
            QualificationPayloadError::SemanticInvalid
        ))
    ));
    assert_eq!(
        fixture.snapshot(),
        before_expired,
        "expired input must not advance ledger state"
    );
}
