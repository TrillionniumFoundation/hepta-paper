use hepta_codex_protocol::Sha256Digest;
use hepta_paper_service::scientific_runtime::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-science-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn children(&self) -> usize {
        fs::read_dir(&self.0).unwrap().count()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn hash(bytes: &[u8]) -> Sha256Digest {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        .parse()
        .unwrap()
}
fn example() -> ScientificJobV1 {
    serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/scientific-python-job.v1.json"
    ))
    .unwrap()
}
fn profile(temp: &Temp, job: &ScientificJobV1) -> ScientificRuntimeProfileV1 {
    let executable =
        fs::canonicalize("/usr/bin/python3").expect("Python 3 is a required test runtime");
    ScientificRuntimeProfileV1 {
        version: 1,
        runtime: ScientificRuntimeKindV1::PythonEmpirical,
        executable_hash: hash(&fs::read(&executable).unwrap()),
        executable,
        runtime_files: BTreeMap::new(),
        job_hash: scientific_job_hash_v1(job).unwrap(),
        scratch_root: temp.0.clone(),
        timeout_ms: 5000,
        maximum_output_bytes: 512 * 1024,
        passes: 1,
    }
}
fn python(script: &str) -> ScientificJobV1 {
    ScientificJobV1 {
        version: 1,
        files: BTreeMap::from([("main.py".into(), script.into())]),
        outputs: vec![ScientificOutputV1 {
            path: "result.json".into(),
            format: ScientificOutputFormatV1::Json,
        }],
    }
}
#[test]
fn documented_experiment_runs_actual_python_and_returns_hash_bound_outputs() {
    let temp = Temp::new();
    let job = example();
    let p = profile(&temp, &job);
    let output = execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").unwrap();
    assert_eq!(output.artifacts.len(), 2);
    let manifest: Value = serde_json::from_slice(&output.artifacts[0]).unwrap();
    let result: Value = serde_json::from_slice(&output.artifacts[1]).unwrap();
    assert_eq!(result["count"], 4);
    assert_eq!(result["mean"], 5);
    assert!((result["sampleVariance"].as_f64().unwrap() - 20.0 / 3.0).abs() < 1e-12);
    assert_eq!(
        manifest["outputs"][0]["sha256"],
        hash(&output.artifacts[1]).to_string()
    );
    assert_eq!(manifest["scientificAcceptance"], false);
    assert_eq!(manifest["productionQualified"], false);
    assert_eq!(manifest["passes"][0]["exitCode"], 0);
    assert_eq!(temp.children(), 1);
}
#[test]
fn real_numerical_program_is_not_the_builtin_linear_kernel() {
    let temp = Temp::new();
    let job = python(
        "import json, math\nfrom pathlib import Path\nh=0.01\ny=1.0\nfor i in range(100): y *= (1-h)\nPath('result.json').write_text(json.dumps({'euler':y,'exact':math.exp(-1)}))\n",
    );
    let mut p = profile(&temp, &job);
    p.runtime = ScientificRuntimeKindV1::PythonNumerical;
    let output = execute_scientific_job_v1(&p, job, "CAP-NUMERICAL").unwrap();
    let result: Value = serde_json::from_slice(&output.artifacts[1]).unwrap();
    assert!((result["euler"].as_f64().unwrap() - result["exact"].as_f64().unwrap()).abs() < 0.002);
}
#[test]
fn changed_job_wrong_capability_and_runtime_drift_fail_before_execution() {
    let temp = Temp::new();
    let job = example();
    let mut p = profile(&temp, &job);
    assert!(execute_scientific_job_v1(&p, job.clone(), "CAP-BUILD").is_err());
    let mut changed = job.clone();
    changed
        .files
        .insert("observations.json".into(), "{}".into());
    assert!(execute_scientific_job_v1(&p, changed, "CAP-EMPIRICAL").is_err());
    p.executable_hash = hash(b"not the runtime");
    assert!(execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").is_err());
    assert_eq!(temp.children(), 0);
}
#[test]
fn paths_collisions_and_unknown_fields_are_rejected() {
    let temp = Temp::new();
    for name in [
        "../escape",
        "/absolute",
        "bad//path",
        "a/../b",
        ".hidden",
        "a\\b",
    ] {
        let mut job = example();
        job.outputs[0].path = name.into();
        let p = profile(&temp, &job);
        assert!(
            execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").is_err(),
            "{name}"
        );
    }
    for name in ["main.py", "main.py/child", "observations.json/child"] {
        let mut job = example();
        job.outputs[0].path = name.into();
        let p = profile(&temp, &job);
        assert!(execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").is_err());
    }
    let mut v = serde_json::to_value(example()).unwrap();
    v["argv"] = serde_json::json!(["-c"]);
    assert!(serde_json::from_value::<ScientificJobV1>(v).is_err());
    assert_eq!(temp.children(), 0);
}
#[test]
fn failed_and_timed_out_programs_never_return_prepared_artifacts() {
    for script in [
        "from pathlib import Path\nPath('result.json').write_text('{}')\nraise RuntimeError('private detail')",
        "import time\ntime.sleep(5)",
    ] {
        let temp = Temp::new();
        let job = python(script);
        let mut p = profile(&temp, &job);
        p.timeout_ms = 100;
        assert!(matches!(
            execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL"),
            Err(ScientificRuntimeError::Execution)
        ));
        assert_eq!(temp.children(), 1); // Retain evidence; never adopt a failed directory.
    }
}
#[test]
fn missing_invalid_empty_or_oversized_outputs_are_rejected() {
    for script in [
        "pass",
        "open('result.json','w').close()",
        "open('result.json','w').write('NaN')",
        "open('result.json','w').write('x'*10000)",
    ] {
        let temp = Temp::new();
        let job = python(script);
        let mut p = profile(&temp, &job);
        p.maximum_output_bytes = 1024;
        assert!(matches!(
            execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL"),
            Err(ScientificRuntimeError::Output)
        ));
    }
}
#[test]
fn symlink_hardlink_directory_and_fifo_outputs_fail_without_blocking() {
    for script in [
        "import os\nos.symlink('/etc/passwd','result.json')",
        "import os\nos.link('main.py','result.json')",
        "import os\nos.mkdir('result.json')",
        "import os\nos.mkfifo('result.json')",
    ] {
        let temp = Temp::new();
        let job = python(script);
        let p = profile(&temp, &job);
        assert!(execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").is_err());
    }
}
#[test]
fn source_mutation_and_log_overflow_are_not_success() {
    for script in [
        "from pathlib import Path\nPath('main.py').write_text('changed')\nPath('result.json').write_text('{}')",
        "print('x'*100000)\nopen('result.json','w').write('{}')",
    ] {
        let temp = Temp::new();
        let job = python(script);
        let p = profile(&temp, &job);
        assert!(execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").is_err());
    }
}
#[test]
fn child_environment_is_fresh_and_home_is_attempt_private() {
    let temp = Temp::new();
    let job = python(
        "import os,json\nfrom pathlib import Path\nPath('result.json').write_text(json.dumps({'homeIsCwd':os.environ['HOME']==os.getcwd(),'keys':sorted(os.environ)}))\n",
    );
    let p = profile(&temp, &job);
    let output = execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").unwrap();
    let v: Value = serde_json::from_slice(&output.artifacts[1]).unwrap();
    assert_eq!(v["homeIsCwd"], true);
    for key in v["keys"].as_array().unwrap() {
        assert!(
            [
                "HOME",
                "LANG",
                "PATH",
                "TMPDIR",
                "openin_any",
                "openout_any",
                "LC_CTYPE"
            ]
            .contains(&key.as_str().unwrap())
        );
    }
}
#[test]
fn profile_is_exact_hash_bound_and_rejects_unsafe_runtime_or_root() {
    let temp = Temp::new();
    let job = example();
    let mut p = profile(&temp, &job);
    let path = temp.0.join("profile.json");
    let bytes = serde_json::to_vec(&p).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert!(read_scientific_profile_v1(&path, &hash(&bytes)).is_ok());
    assert!(read_scientific_profile_v1(&path, &hash(b"other")).is_err());
    let link = temp.0.join("runtime");
    symlink(&p.executable, &link).unwrap();
    p.executable = link;
    assert!(execute_scientific_job_v1(&p, job.clone(), "CAP-EMPIRICAL").is_err());
    p = profile(&temp, &job);
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").is_err());
}
#[test]
fn cumulative_output_budget_is_enforced() {
    let temp = Temp::new();
    let mut job = python("pass");
    job.files.insert(
        "main.py".into(),
        "open('result.json','w').write(' '*700+'{}')\nopen('second.json','w').write(' '*700+'{}')"
            .into(),
    );
    job.outputs.push(ScientificOutputV1 {
        path: "second.json".into(),
        format: ScientificOutputFormatV1::Json,
    });
    let mut p = profile(&temp, &job);
    p.maximum_output_bytes = 1024;
    assert!(matches!(
        execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL"),
        Err(ScientificRuntimeError::Output)
    ));
}
#[test]
#[ignore = "requires an independently installed pdflatex; run explicitly on the tool-equipped test host"]
fn actual_latex_compilation_produces_pdf_not_a_json_bundle() {
    let temp = Temp::new();
    let job = ScientificJobV1 {version:1, files:BTreeMap::from([("main.tex".into(),
        "\\documentclass{article}\n\\begin{document}\nRust scientific execution test.\\end{document}\n".into())]),
        outputs:vec![ScientificOutputV1{path:"paper.pdf".into(),format:ScientificOutputFormatV1::Pdf}]};
    let mut p = profile(&temp, &job);
    p.runtime = ScientificRuntimeKindV1::PdfLatex;
    p.executable = fs::canonicalize(Path::new("/usr/bin/pdflatex")).unwrap();
    p.executable_hash = hash(&fs::read(&p.executable).unwrap());
    p.passes = 2;
    let out = execute_scientific_job_v1(&p, job, "CAP-BUILD").unwrap();
    assert!(out.artifacts[1].starts_with(b"%PDF-"));
    let manifest: Value = serde_json::from_slice(&out.artifacts[0]).unwrap();
    assert_eq!(manifest["passes"].as_array().unwrap().len(), 2);
}

#[test]
fn named_manifest_resolution_is_order_independent_and_rejects_uncommitted_references() {
    let temp = Temp::new();
    let job = example();
    let p = profile(&temp, &job);
    let output = execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").unwrap();
    let store_dir = temp.0.join("store");
    let objects = hepta_paper_service::ObjectStoreV1::open(&store_dir).unwrap();
    let mut hashes: Vec<_> = output
        .artifacts
        .iter()
        .map(|b| objects.put(b).unwrap())
        .collect();
    let expected = hashes[1].clone();
    assert_eq!(
        resolve_scientific_output_v1(&objects, &hashes, "result.json", "CAP-EMPIRICAL").unwrap(),
        expected
    );
    hashes.reverse();
    assert_eq!(
        resolve_scientific_output_v1(&objects, &hashes, "result.json", "CAP-EMPIRICAL").unwrap(),
        expected
    );
    assert!(
        resolve_scientific_output_v1(&objects, &hashes, "unknown.json", "CAP-EMPIRICAL").is_err()
    );
    let mut manifest: Value = serde_json::from_slice(&output.artifacts[0]).unwrap();
    let extra = objects.put(b"{\"notCommitted\":true}").unwrap();
    manifest["outputs"][0]["sha256"] = serde_json::json!(extra);
    let forged = objects
        .put(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    assert!(
        resolve_scientific_output_v1(
            &objects,
            &[forged, expected],
            "result.json",
            "CAP-EMPIRICAL"
        )
        .is_err()
    );
}
#[test]
fn closed_manifest_rejects_duplicate_names_size_drift_and_extra_artifacts() {
    let temp = Temp::new();
    let job = example();
    let p = profile(&temp, &job);
    let output = execute_scientific_job_v1(&p, job, "CAP-EMPIRICAL").unwrap();
    let objects = hepta_paper_service::ObjectStoreV1::open(&temp.0.join("store")).unwrap();
    let data = objects.put(&output.artifacts[1]).unwrap();
    let original: Value = serde_json::from_slice(&output.artifacts[0]).unwrap();
    for variant in 0..7 {
        let mut m = original.clone();
        match variant {
            0 => {
                let row = m["outputs"][0].clone();
                m["outputs"].as_array_mut().unwrap().push(row);
            }
            1 => m["outputs"][0]["bytes"] = serde_json::json!(1),
            2 => m["productionQualified"] = serde_json::json!(true),
            3 => m["unexpected"] = serde_json::json!(true),
            4 => m["outputs"][0]["format"] = serde_json::json!("pdf"),
            5 => m["outputs"][0]["path"] = serde_json::json!("main.py"),
            _ => m["inputHashes"] = serde_json::json!({"other.py": hash(b"other")}),
        }
        let mh = objects.put(&serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(
            resolve_scientific_output_v1(
                &objects,
                &[mh, data.clone()],
                "result.json",
                "CAP-EMPIRICAL"
            )
            .is_err()
        );
    }
    let mh = objects.put(&output.artifacts[0]).unwrap();
    let extra = objects.put(b"unclassified").unwrap();
    assert!(
        resolve_scientific_output_v1(&objects, &[mh, data, extra], "result.json", "CAP-EMPIRICAL")
            .is_err()
    );
}
#[test]
fn cli_hash_setup_uses_exact_documented_job_and_never_runs_a_program() {
    let path = fs::canonicalize(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/modules/examples/scientific-python-job.v1.json"),
    )
    .unwrap();
    let binary = env!("CARGO_BIN_EXE_hepta-scientific-worker");
    let out = std::process::Command::new(binary)
        .args(["job-hash", path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        scientific_job_hash_v1(&example()).unwrap().as_str()
    );
    let out = std::process::Command::new(binary)
        .args(["file-hash", path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        hash(&fs::read(&path).unwrap()).as_str()
    );
}
