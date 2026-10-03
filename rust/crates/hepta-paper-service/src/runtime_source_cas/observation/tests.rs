use super::*;
#[test]
fn observation_budget_accepts_exact_boundary_and_refuses_excess_without_overflow() {
    let mut budget = ObservationBudget::default();
    budget
        .account(MAX_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES)
        .unwrap();
    assert!(
        budget
            .account(MAX_DOCUMENT_BYTES + 1, MAX_DOCUMENT_BYTES)
            .is_err()
    );
    budget
        .account(MAX_TOTAL_BYTES - MAX_DOCUMENT_BYTES, MAX_TOTAL_BYTES)
        .unwrap();
    assert!(budget.account(1, MAX_DOCUMENT_BYTES).is_err());
    assert!(budget.account(u64::MAX, u64::MAX).is_err());
    assert_eq!(budget.bytes, MAX_TOTAL_BYTES);
}
#[test]
fn directory_entry_budget_is_consumed_before_retaining_an_extra_source() {
    let root = std::env::temp_dir().join(format!(
        "hepta-cas-observation-{}",
        super::super::random_nonce().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    for name in ["a", "b", "c"] {
        fs::write(root.join(name), b"fixture").unwrap();
    }
    let cancelled = AtomicBool::new(false);
    let mut observed = SourceObservation::new(&root, &cancelled).unwrap();
    let mut remaining = 2;
    let mut names = Vec::new();
    assert_eq!(
        observed
            .walk(&root, "", 0, &mut remaining, &mut names)
            .unwrap_err(),
        BOUND
    );
    assert_eq!(remaining, 0);
    assert_eq!(names.len(), 2);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
    drop(observed);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn first_enumeration_captures_current_children_but_never_rebases_sealed_inventory() {
    let root = std::env::temp_dir().join(format!(
        "hepta-cas-enumeration-{}",
        super::super::random_nonce().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    let cancelled = AtomicBool::new(false);
    let mut observed = SourceObservation::new(&root, &cancelled).unwrap();
    fs::write(root.join("a"), b"first").unwrap();
    assert_eq!(observed.document(Path::new("a")).unwrap(), b"first");
    fs::write(root.join("b"), b"second").unwrap();
    let mut names = observed.files(Path::new("")).unwrap();
    names.sort();
    assert_eq!(names, ["a", "b"]);
    observed.assert_current().unwrap();
    fs::write(root.join("c"), b"later").unwrap();
    assert_eq!(observed.files(Path::new("")).unwrap_err(), CHANGED);
    assert_eq!(observed.assert_current().unwrap_err(), CHANGED);
    assert_eq!(fs::read(root.join("c")).unwrap(), b"later");
    drop(observed);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn traversed_ancestors_allow_unobserved_siblings_until_the_namespace_is_sealed() {
    let root = std::env::temp_dir().join(format!(
        "hepta-cas-ancestor-{}",
        super::super::random_nonce().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/held"), b"original").unwrap();
    let cancelled = AtomicBool::new(false);
    let mut observed = SourceObservation::new(&root, &cancelled).unwrap();
    assert!(
        observed
            .inventory_probe(Path::new("nested/held"))
            .unwrap()
            .is_some()
    );
    fs::write(root.join("nested/unobserved"), b"sibling").unwrap();
    assert!(
        observed
            .inventory_probe(Path::new("nested/held"))
            .unwrap()
            .is_some()
    );
    assert_eq!(
        observed.document(Path::new("nested/held")).unwrap(),
        b"original"
    );
    let names: Vec<_> = observed
        .inventory_entries(Path::new("nested"))
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(names, ["held", "unobserved"]);
    fs::write(root.join("nested/after-seal"), b"later").unwrap();
    assert_eq!(
        observed
            .inventory_probe(Path::new("nested/held"))
            .unwrap_err(),
        CHANGED
    );
    assert_eq!(observed.assert_current().unwrap_err(), CHANGED);
    drop(observed);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_inventory_edge_seals_its_parent_before_later_sibling_creation() {
    let root = std::env::temp_dir().join(format!(
        "hepta-cas-absence-{}",
        super::super::random_nonce().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    let cancelled = AtomicBool::new(false);
    let mut observed = SourceObservation::new(&root, &cancelled).unwrap();
    assert!(
        observed
            .inventory_probe(Path::new("nested/missing"))
            .unwrap()
            .is_none()
    );
    fs::write(root.join("nested/unrelated"), b"new").unwrap();
    assert_eq!(
        observed
            .inventory_probe(Path::new("nested/missing"))
            .unwrap_err(),
        CHANGED
    );
    assert_eq!(observed.assert_current().unwrap_err(), CHANGED);
    drop(observed);
    fs::remove_dir_all(root).unwrap();
}
