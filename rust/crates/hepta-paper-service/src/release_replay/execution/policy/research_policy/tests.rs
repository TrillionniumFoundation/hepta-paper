use super::super::{
    archive::PinnedArchive, environment, fixture_test_support, measured_profile::SourceLimits,
    process,
};
use super::*;
const CATALOG_BYTES: &[u8] =
    include_bytes!("../../../../../../../../migration/research-verify-retirements.mjs");
const FIXTURE_HASH: &str =
    "sha256:45169040aaab3a4e21510adada32e519b1f4f09c42b6fc5075e6c3afc4994eb1";
fn sources(owner: &mut Owner<'_>, tree: &mut PrivateTree) -> Matrix {
    let root = owner.request.source.workspace_root.clone();
    let mut matrix: Matrix = serde_json::from_slice(
        &std::fs::read(root.join("migration/legacy-semantic-migration-matrix.json")).unwrap(),
    )
    .unwrap();
    matrix
        .entries
        .retain(|r| r.behavior_tests.len() == 1 && r.behavior_tests[0].path == SUITE);
    assert_eq!(matrix.entries.len(), 155);
    let tar = owner.tool(Path::new("/usr/bin/tar"), None).unwrap();
    let mut archive = PinnedArchive::capture(
        owner,
        &root.join("rust/oracle/research-retired-sources.v1.tar.gz"),
        FIXTURE_HASH,
        512 * 1024,
    )
    .unwrap();
    let receipt = archive
        .materialize(owner, &tar, &matrix, tree, SourceLimits::OriginalV4)
        .unwrap();
    assert_eq!(receipt["memberCount"], 155);
    assert_eq!(receipt["fullArchiveRestored"], false);
    archive.assert_current(owner).unwrap();
    tree.assert_sources(&matrix, owner).unwrap();
    matrix
}
fn ast(owner: &mut Owner<'_>, tree: &PrivateTree, matrix: &Matrix) -> (Value, Value) {
    let mut cases = Vec::new();
    let mut bindings = Vec::new();
    for row in &matrix.entries {
        let bytes = tree.read_source(&row.source.path, owner).unwrap();
        assert_eq!(digest(&bytes), format!("sha256:{}", row.source.sha256));
        cases.push(json!({"version":1,"kind":"NativePythonRetirementAstRequest","profile":"research_verify_v1","source":std::str::from_utf8(&bytes).unwrap()}));
        bindings.push(json!({"matrixId":row.id,"sourcePath":row.source.path,"sourceSha256":digest(&bytes),"profile":"research_verify_v1"}));
    }
    let input = serde_json::to_vec(
        &json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":cases}),
    )
    .unwrap();
    let output =
        crate::release_replay::python_ast::inspect_python_ast_worker_bytes_v1(&input).unwrap();
    let value: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["caseCount"], 155);
    assert_eq!(value["sourceExecuted"], false);
    (json!({"native":value}), json!({"bindings":bindings}))
}
#[test]
fn exact_research_catalog_and_retired_local_harness_domains_are_source_bound() {
    let table = retirement_policy::fixed_research_symbol_table(CATALOG_BYTES).unwrap();
    assert_eq!(table.len(), 155);
    for path in [SMOKE, FORMAL] {
        assert_eq!(table.iter().filter(|(p, _)| p == path).count(), 1);
        assert!(execution_disposition(disposition(path)));
    }
    let mut changed = CATALOG_BYTES.to_vec();
    changed.push(b'\n');
    assert!(retirement_policy::fixed_research_symbol_table(&changed).is_err());
    assert!(
        retirement_policy::fixed_symbol_table(
            CATALOG_BYTES,
            "sha256:ad5ca54eb2b0a6ba881123b018d281d933ed52b0cd204013d722122dcb39576f",
            "PUBLIC_SYMBOLS"
        )
        .is_err()
    );
}
#[test]
fn actual_155_native_ast_original_python_and_whole_node_retirement_suite_match_without_execution_authority()
 {
    let helper = fixture_test_support::FixtureOwner::new();
    let mut owner = helper.owner();
    let mut tree = PrivateTree::new().unwrap();
    let matrix = sources(&mut owner, &mut tree);
    let ast = ast(&mut owner, &tree, &matrix);
    let paths = super::super::graph_paths(&mut owner).unwrap();
    let mut graph = SourceGraph::capture_paths(&mut owner, paths).unwrap();
    let mut observed = inspect_component(&mut owner, &mut graph, &matrix, &ast, &tree).unwrap();
    let mut python = owner.tool(Path::new("/usr/bin/python3"), None).unwrap();
    let mut node = owner.tool(&fixture_test_support::node(), None).unwrap();
    let suite = graph.read_input(&mut owner, SUITE).unwrap();
    let text = std::str::from_utf8(&suite).unwrap();
    let script = text
        .split("const pythonAudit = String.raw`")
        .nth(1)
        .unwrap()
        .split("`;\n")
        .next()
        .unwrap();
    let runtime = tree.directory("runtimes/research-suite-observer").unwrap();
    let env = environment(BTreeMap::from([
        ("HOME".into(), runtime.to_string_lossy().into_owned()),
        ("TMPDIR".into(), runtime.to_string_lossy().into_owned()),
        ("HEPTA_LEGACY_REFERENCE_PREPARED".into(), "1".into()),
        (
            "PAPER_FACTORY_LEGACY_ROOT".into(),
            tree.sources().to_string_lossy().into_owned(),
        ),
    ]))
    .unwrap();
    let mut args = vec!["-c".into(), script.into()];
    args.extend(
        matrix
            .entries
            .iter()
            .map(|r| tree.sources().join(&r.source.path).into_os_string()),
    );
    let (python_output, python_receipt) = process(
        &owner,
        &python,
        args,
        None,
        env.clone(),
        1024 * 1024,
        Some(&mut tree),
    )
    .unwrap();
    let original: Value = serde_json::from_slice(&python_output).unwrap();
    assert_eq!(original, ast.0["native"]["audits"]);
    let (output, node_receipt) = process(
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
    assert_eq!(observed.accepted_source_paths.len(), 155);
    assert_eq!(
        observed.receipt["localHarnesses"].as_array().unwrap().len(),
        2
    );
    assert_eq!(observed.receipt["authorityGranted"], false);
    tree.assert_sources(&matrix, &mut owner).unwrap();
    graph.assert_current(&mut owner).unwrap();
    owner.assert_tool(&mut python).unwrap();
    owner.assert_tool(&mut node).unwrap();
    eprintln!(
        "{}",
        json!({"scope":"actual_155_source_component_only","nativeObservation":observed.receipt,"actualWholeNodeSuite":result,"actualWholePythonAstMatched":true,"pythonProcess":python_receipt,"nodeProcess":node_receipt})
    );
    let root = tree.sources().parent().unwrap().to_owned();
    tree.cleanup().unwrap();
    assert!(!root.exists());
}
#[test]
fn absent_fixture_creation_symlink_and_cancelled_fresh_retry_refuse_without_authority() {
    let helper = fixture_test_support::FixtureOwner::new();
    let mut owner = helper.owner();
    let mut tree = PrivateTree::new().unwrap();
    let matrix = sources(&mut owner, &mut tree);
    let ast = ast(&mut owner, &tree, &matrix);
    let paths = super::super::graph_paths(&mut owner).unwrap();
    let mut graph = SourceGraph::capture_paths(&mut owner, paths).unwrap();
    let selected = tree.sources().join("hepta-paper-workspace");
    let held = missing(&selected.join("migration/fixtures/missing-research-source")).unwrap();
    std::fs::create_dir(&selected).unwrap();
    assert!(held.assert_current().is_err());
    std::fs::remove_dir(&selected).unwrap();
    assert!(held.assert_current().is_err());
    std::os::unix::fs::symlink("missing-target", &selected).unwrap();
    assert!(missing(&selected.join("migration/fixtures/missing-research-source")).is_err());
    std::fs::remove_file(&selected).unwrap();
    inspect_component(&mut owner, &mut graph, &matrix, &ast, &tree).unwrap();
    helper.cancel();
    assert!(
        inspect_component(&mut owner, &mut graph, &matrix, &ast, &tree)
            .err()
            .unwrap()
            .contains("cancelled")
    );
    let retry_helper = fixture_test_support::FixtureOwner::new();
    let mut retry_owner = retry_helper.owner();
    let retry_paths = super::super::graph_paths(&mut retry_owner).unwrap();
    let mut retry_graph = SourceGraph::capture_paths(&mut retry_owner, retry_paths).unwrap();
    let retry =
        inspect_component(&mut retry_owner, &mut retry_graph, &matrix, &ast, &tree).unwrap();
    assert_eq!(retry.accepted_source_paths.len(), 155);
    assert_eq!(retry.receipt["authorityGranted"], false);
    tree.assert_sources(&matrix, &mut retry_owner).unwrap();
    retry_graph.assert_current(&mut retry_owner).unwrap();
    let root = tree.sources().parent().unwrap().to_owned();
    tree.cleanup().unwrap();
    assert!(!root.exists());
}
