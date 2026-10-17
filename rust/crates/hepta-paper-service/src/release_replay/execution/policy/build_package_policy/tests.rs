use super::*;
const CATALOG_BYTES: &[u8] =
    include_bytes!("../../../../../../../../migration/build-package-retirements.mjs");
#[test]
fn fixed_actual_build_catalog_lookup_symbols_and_raw_byte_guard_are_real() {
    let table =
        retirement_policy::fixed_symbol_table(CATALOG_BYTES, CATALOG_HASH, "PUBLIC_SYMBOLS")
            .unwrap();
    assert_eq!(table.len(), 36);
    assert_eq!(
        table
            .iter()
            .filter(|(path, _)| path == runner_contract::LOCAL_WRITER)
            .count(),
        1
    );
    assert!(table.iter().all(|(_, symbols)| symbols.len() >= 2));
    assert!(
        table
            .iter()
            .all(|(path, _)| path != "paperctl_modules/not-retired.py")
    );
    let mut changed = CATALOG_BYTES.to_vec();
    changed.push(b'\n');
    assert!(
        retirement_policy::fixed_symbol_table(&changed, CATALOG_HASH, "PUBLIC_SYMBOLS").is_err()
    );
    assert!(
        retirement_policy::fixed_symbol_table(CATALOG_BYTES, CATALOG_HASH, "CALLER_PROGRAM")
            .is_err()
    );
}
#[test]
fn full_node_summary_must_match_whole_value_before_complete_policy_receipt() {
    let summary = json!({"ok":true,"kind":"P1BuildPackageExplicitRetirementTest","retiredSourceCount":36,"pureReportSourceCount":35,"localContractMaterializerCount":1,"publicSymbolCount":74,"externalActions":0,"heptaProductionReferences":0});
    let mut observed = Observed {
        summary: summary.clone(),
        accepted_source_paths: BTreeSet::new(),
        receipt: json!({}),
    };
    let mut executions = BTreeMap::from([(SUITE.to_owned(), json!({"actualResult":summary}))]);
    compare(&mut observed, &executions).unwrap();
    assert_eq!(
        observed.receipt["actualSameInputFullNodeSuiteResultsMatched"],
        true
    );
    executions.get_mut(SUITE).unwrap()["actualResult"]["extraClaim"] = json!(true);
    assert!(compare(&mut observed, &executions).is_err());
    executions.get_mut(SUITE).unwrap()["actualResult"]["externalActions"] = json!(1);
    assert!(compare(&mut observed, &executions).is_err());
}

#[test]
fn actual_36_selected_archive_sources_native_ast_and_complete_original_node_suite_match() {
    use super::super::fixture_test_support::{self, FixtureOwner};
    let helper = FixtureOwner::for_policy_graph();
    let mut owner = helper.owner();
    let mut tree = PrivateTree::new().unwrap();
    let matrix = fixture_test_support::sources(&mut owner, &mut tree);
    let ast = fixture_test_support::ast(&mut owner, &tree, &matrix);
    // The public V11 owner continues requiring the actual 245-source AST batch.
    // This test exercises only the exact 36-source native P1 component, never a
    // fabricated full-archive result or a complete ordinary retirement route.
    let paths = super::super::graph_paths(&mut owner).unwrap();
    let mut graph = SourceGraph::capture_paths(&mut owner, paths).unwrap();
    let mut python = owner
        .tool(std::path::Path::new("/usr/bin/python3"), None)
        .unwrap();
    let mut node = owner.tool(&fixture_test_support::node(), None).unwrap();
    let mut observed =
        inspect_component(&mut owner, &mut graph, &matrix, &ast, &mut tree, &python).unwrap();
    let temporary = tree.directory("runtimes/node-build-package-suite").unwrap();
    let env = environment(BTreeMap::from([
        ("HEPTA_LEGACY_REFERENCE_PREPARED".into(), "1".into()),
        (
            "PAPER_FACTORY_LEGACY_ROOT".into(),
            tree.sources().to_string_lossy().into_owned(),
        ),
        ("HOME".into(), temporary.to_string_lossy().into_owned()),
        ("TMPDIR".into(), temporary.to_string_lossy().into_owned()),
    ]))
    .unwrap();
    let (output, process_receipt) = process(
        &owner,
        &node,
        vec![helper.root().join(SUITE).into_os_string()],
        None,
        env,
        1024 * 1024,
        Some(&mut tree),
    )
    .unwrap();
    let result: Value = serde_json::from_slice(&output).unwrap();
    compare(
        &mut observed,
        &BTreeMap::from([(SUITE.into(), json!({"actualResult":result}))]),
    )
    .unwrap();
    assert_eq!(observed.accepted_source_paths.len(), 36);
    assert_eq!(
        observed.receipt["actualSameInputFullNodeSuiteResultsMatched"],
        true
    );
    assert_eq!(
        observed.receipt["materializer"]["sameInputArchivedPythonWholeValueMatched"],
        true
    );
    assert_eq!(observed.receipt["authorityGranted"], false);
    tree.assert_sources(&matrix, &mut owner).unwrap();
    graph.assert_current(&mut owner).unwrap();
    owner.assert_tool(&mut python).unwrap();
    owner.assert_tool(&mut node).unwrap();
    eprintln!(
        "{}",
        json!({"scope":"actual_36_source_subset_component_only","nativeObservation":observed.receipt,"actualNodeWholeSuite":result,"nodeProcess":process_receipt})
    );
    let root = tree.sources().parent().unwrap().to_owned();
    tree.cleanup().unwrap();
    assert!(!root.exists());
}

#[test]
fn cancelled_component_and_invalid_materializer_clean_the_same_private_tree_without_authority() {
    use super::super::fixture_test_support::{self, FixtureOwner};
    let helper = FixtureOwner::for_policy_graph();
    let mut owner = helper.owner();
    let mut tree = PrivateTree::new().unwrap();
    let matrix = fixture_test_support::sources(&mut owner, &mut tree);
    let ast = fixture_test_support::ast(&mut owner, &tree, &matrix);
    let paths = super::super::graph_paths(&mut owner).unwrap();
    let mut graph = SourceGraph::capture_paths(&mut owner, paths).unwrap();
    let python = owner
        .tool(std::path::Path::new("/usr/bin/python3"), None)
        .unwrap();
    let native_path = tree
        .directory("runtimes/cancelled-native-contract")
        .unwrap();
    let directory = Directory::open_or_create(&native_path, false).unwrap();
    let (target, authoring) = inputs();
    runner_contract::materialize(
        &directory,
        &target,
        &authoring,
        &json!({}),
        "fixture",
        true,
        "fixed",
    )
    .unwrap();
    let mut invalid = target.clone();
    invalid["summary"]["target_paper_count"] = json!(1.5);
    assert!(
        runner_contract::materialize(
            &directory,
            &invalid,
            &authoring,
            &json!({}),
            "fixture",
            true,
            "fixed"
        )
        .is_err()
    );
    helper.cancel();
    assert!(
        inspect_component(&mut owner, &mut graph, &matrix, &ast, &mut tree, &python)
            .err()
            .unwrap()
            .contains("cancelled")
    );
    let root = tree.sources().parent().unwrap().to_owned();
    tree.cleanup().unwrap();
    assert!(!root.exists());
}
