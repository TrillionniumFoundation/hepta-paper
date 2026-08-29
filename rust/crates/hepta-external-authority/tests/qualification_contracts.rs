use std::{path::PathBuf, process::Command};

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crate must live below rust/crates")
        .to_path_buf()
}

#[test]
fn external_evidence_schemas_are_closed_draft_2020_12_objects() {
    let root = repository_root();
    let schemas = [
        "hepta-broker-qualification-evidence-v1.schema.json",
        "independent-linux-review-v1.schema.json",
        "external-key-owner-drill-v1.schema.json",
        "authenticated-codex-role-canary-v1.schema.json",
        "production-cutover-soak-v1.schema.json",
        "external-authority-set-v1.schema.json",
    ];
    let script = r#"
import json
import pathlib
import sys
for selected in sys.argv[1:]:
    value = json.loads(pathlib.Path(selected).read_text(encoding='utf-8'))
    assert value['$schema'] == 'https://json-schema.org/draft/2020-12/schema'
    assert value['type'] == 'object'
    assert value['additionalProperties'] is False
    assert value['properties']['schemaVersion']['const'] == 1
    assert value['required']
"#;
    let paths = schemas.map(|name| {
        root.join("docs/rust/qualification")
            .join(name)
            .into_os_string()
    });
    let status = Command::new("python3")
        .arg("-I")
        .arg("-c")
        .arg(script)
        .args(paths)
        .status()
        .expect("Python 3 is required for JSON contract validation");
    assert!(status.success());
}

#[test]
fn target_host_harnesses_are_shell_syntax_valid() {
    let root = repository_root();
    for script in [
        "hepta-broker-host-qualification-v2.sh",
        "hepta-cgroup-v2-target-host-qualification.sh",
    ] {
        let status = Command::new("bash")
            .arg("-n")
            .arg(root.join("docs/rust/qualification").join(script))
            .status()
            .expect("Bash is required for qualification syntax validation");
        assert!(status.success(), "invalid qualification harness: {script}");
    }
}
