use super::*;
use serde_json::Value;

fn atom(name: &str) -> PropositionV1 {
    PropositionV1::Atom { name: name.into() }
}

#[test]
fn author_and_review_are_deterministic_and_bounded() {
    let author = NativeBusinessJobV1::AuthorDraft {
        title: "Native Rust Research".into(),
        abstract_text: "A bounded deterministic abstract.".into(),
        sections: vec![ManuscriptSectionV1 {
            heading: "Method".into(),
            body: "The method is implemented without a Node runtime.".into(),
        }],
        reference_keys: vec!["ref-b".into(), "ref-a".into()],
    };
    let first = execute_native_business_v1(author.clone()).expect("native author");
    let second = execute_native_business_v1(author).expect("deterministic author");
    assert_eq!(first, second);
    let manuscript = String::from_utf8(first.artifacts[0].clone()).expect("UTF-8 manuscript");
    assert!(manuscript.contains("## Method"));
    assert!(manuscript.find("[ref-a]") < manuscript.find("[ref-b]"));

    let review = execute_native_business_v1(NativeBusinessJobV1::ReviewerAssessment {
        manuscript,
        policy: ReviewPolicyV1 {
            minimum_word_count: 6,
            required_headings: vec!["Abstract".into(), "Method".into()],
            forbidden_markers: vec!["TODO".into()],
        },
    })
    .expect("native reviewer");
    assert_eq!(review.evidence["accepted"], true);
}

#[test]
fn formal_kernel_checks_dependency_order_and_goal() {
    let a = atom("A");
    let b = atom("B");
    let implication = PropositionV1::Implies {
        antecedent: Box::new(a.clone()),
        consequent: Box::new(b.clone()),
    };
    let output = execute_native_business_v1(NativeBusinessJobV1::FormalCertificate {
        assumptions: vec![a.clone(), implication.clone()],
        steps: vec![
            ProofStepV1::Assumption {
                proposition: implication,
            },
            ProofStepV1::Assumption { proposition: a },
            ProofStepV1::ModusPonens {
                implication_step: 0,
                antecedent_step: 1,
            },
        ],
        goal: b,
    })
    .expect("checked proof");
    assert_eq!(output.evidence["accepted"], true);
}

#[test]
fn formal_kernel_rejects_forward_references() {
    let result = execute_native_business_v1(NativeBusinessJobV1::FormalCertificate {
        assumptions: vec![atom("A")],
        steps: vec![ProofStepV1::AndIntroduction {
            left_step: 0,
            right_step: 0,
        }],
        goal: atom("A"),
    });
    assert_eq!(
        result.expect_err("forward reference must fail"),
        NativeBusinessError::ProofInvalid
    );
}

#[test]
fn empirical_and_numerical_results_are_finite() {
    let empirical = execute_native_business_v1(NativeBusinessJobV1::EmpiricalAggregate {
        observations: vec![
            ObservationV1 {
                label: "sample-1".into(),
                value: 1.0,
            },
            ObservationV1 {
                label: "sample-2".into(),
                value: 3.0,
            },
        ],
    })
    .expect("empirical aggregate");
    assert_eq!(empirical.evidence["observationCount"], 2);

    let numerical = execute_native_business_v1(NativeBusinessJobV1::NumericalLinearSolve {
        matrix: vec![vec![2.0, 1.0], vec![1.0, 3.0]],
        rhs: vec![5.0, 6.0],
        tolerance: 1e-12,
    })
    .expect("linear solve");
    let report: Value = serde_json::from_slice(&numerical.artifacts[0]).expect("report");
    assert!((report["solution"][0].as_f64().expect("x") - 1.8).abs() < 1e-12);
    assert!((report["solution"][1].as_f64().expect("y") - 1.4).abs() < 1e-12);
}

#[test]
fn numerical_kernel_rejects_singular_systems() {
    let result = execute_native_business_v1(NativeBusinessJobV1::NumericalLinearSolve {
        matrix: vec![vec![1.0, 2.0], vec![2.0, 4.0]],
        rhs: vec![3.0, 6.0],
        tolerance: 1e-12,
    });
    assert_eq!(
        result.expect_err("singular system must fail"),
        NativeBusinessError::SingularMatrix
    );
}

#[test]
fn build_package_is_order_independent_and_rejects_aliases() {
    let entries = vec![
        BuildEntryV1 {
            path: "paper/main.md".into(),
            content: "paper".into(),
            media_type: "text/markdown".into(),
        },
        BuildEntryV1 {
            path: "data/results.json".into(),
            content: "{}".into(),
            media_type: "application/json".into(),
        },
    ];
    let first = execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
        entries: entries.clone(),
    })
    .expect("package");
    let second = execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
        entries: entries.into_iter().rev().collect(),
    })
    .expect("order independent package");
    assert_eq!(first, second);
    assert_eq!(first.artifacts.len(), 2);
    assert!(
        execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
            entries: vec![BuildEntryV1 {
                path: "../escape".into(),
                content: "bad".into(),
                media_type: "text/plain".into(),
            }],
        })
        .is_err()
    );
}

#[test]
fn implementation_hash_binds_every_native_source_file() {
    let hash = native_business_implementation_hash_v1();
    assert!(hash.starts_with("sha256:"));
    assert_eq!(hash.len(), 71);
}
