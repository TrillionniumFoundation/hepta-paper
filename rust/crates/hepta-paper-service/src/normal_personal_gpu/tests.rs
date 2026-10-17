use super::*;
use crate::personal_self_hosted_gpu::write_personal_gpu_receipt_with_control_v1;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-normal-gpu-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn retained_receipt_rejects_post_wire_rewrite_alias_and_equivalent_bytes_replacement_then_fresh_retry()
 {
    let root = Temp::new();
    let path = root.0.join("receipt.json");
    let report = blocked_personal_gpu_receipt_v1(1750000000000, None, "fixture").unwrap();
    let wire = encode_personal_gpu_operational_receipt_v1(&report).unwrap();
    fs::write(&path, &wire).unwrap();
    for mode in ["rewrite", "replace", "alias"] {
        let flag = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(120);
        let observed =
            read_retained_personal_gpu_receipt_v1(&path, flag.clone(), deadline).unwrap();
        let bytes = encode(observed.bytes(), &flag, deadline).unwrap();
        assert!(!bytes.is_empty());
        match mode {
            "rewrite" => fs::write(&path, &wire).unwrap(),
            "replace" => {
                let replacement = root.0.join("replacement");
                fs::write(&replacement, &wire).unwrap();
                fs::rename(replacement, &path).unwrap();
            }
            _ => {
                let target = root.0.join("target");
                fs::rename(&path, &target).unwrap();
                symlink(&target, &path).unwrap();
            }
        }
        assert_eq!(
            observed.assert_current().unwrap_err(),
            "personal_gpu_check_input_changed"
        );
        if mode == "alias" {
            fs::remove_file(&path).unwrap();
            fs::rename(root.0.join("target"), &path).unwrap();
        }
        read_retained_personal_gpu_receipt_v1(&path, flag, deadline)
            .unwrap()
            .assert_current()
            .unwrap();
    }
}
#[test]
fn original_controls_refuse_before_io_and_after_encoding_without_rebinding() {
    let root = Temp::new();
    let path = root.0.join("absent");
    let flag = Arc::new(AtomicBool::new(true));
    let deadline = Instant::now() + Duration::from_secs(120);
    assert_eq!(
        read_retained_personal_gpu_receipt_v1(&path, flag.clone(), deadline)
            .err()
            .unwrap(),
        "personal_gpu_check_cancelled"
    );
    assert_eq!(
        write_personal_gpu_receipt_with_control_v1(&path, "{}", &flag, deadline)
            .unwrap_err()
            .to_string(),
        "personal_gpu_check_cancelled"
    );
    assert!(!path.exists());
    flag.store(false, Ordering::Release);
    assert_eq!(
        read_retained_personal_gpu_receipt_v1(&path, flag.clone(), Instant::now())
            .err()
            .unwrap(),
        "personal_gpu_check_deadline_exceeded"
    );
    fs::write(&path, "{}").unwrap();
    let input = read_retained_personal_gpu_receipt_v1(&path, flag.clone(), deadline).unwrap();
    let _ = encode(input.bytes(), &flag, deadline).unwrap();
    flag.store(true, Ordering::Release);
    assert_eq!(
        input.assert_current().unwrap_err(),
        "personal_gpu_check_cancelled"
    );
    flag.store(false, Ordering::Release);
    read_retained_personal_gpu_receipt_v1(&path, flag, deadline)
        .unwrap()
        .assert_current()
        .unwrap();
}
#[test]
fn ordinary_help_and_original_grammar_do_not_require_a_deployment_root() {
    let output = inspect_normal_personal_gpu_v1(
        &["--help".into(), "--run-id=ignored".into()],
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert_eq!(output.stdout, format!("{PERSONAL_GPU_USAGE}\n").as_bytes());
    for args in [
        vec!["--help", "--unknown"],
        vec!["--check=true"],
        vec!["--receipt"],
        vec!["--help", "--help"],
    ] {
        assert!(
            inspect_normal_personal_gpu_v1(
                &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
                Arc::new(AtomicBool::new(false))
            )
            .is_err()
        );
    }
}
