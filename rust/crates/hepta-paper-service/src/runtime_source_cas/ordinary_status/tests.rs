use super::*;
use std::{
    os::unix::fs::symlink,
    sync::atomic::Ordering,
    time::{Duration, SystemTime},
};

fn root(name: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "hepta-r-normal-{name}-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    root
}
#[test]
fn missing_context_first_edge_retains_create_remove_replace_and_fresh_retry() {
    for intermediate in [false, true] {
        let root = root("context");
        if intermediate {
            fs::create_dir(root.join("runtime-images")).unwrap();
        }
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(120);
        let observed = inspect_retained_status_v1(&root, &cancelled, deadline).unwrap();
        assert_eq!(observed.report["ready"], false);
        observed.assert_current().unwrap();
        let first = if intermediate {
            root.join("runtime-images/r-scientific")
        } else {
            root.join("runtime-images")
        };
        fs::create_dir(&first).unwrap();
        fs::remove_dir(&first).unwrap();
        assert_eq!(
            observed.assert_current().unwrap_err(),
            "r_runtime_source_cas_input_changed"
        );
        let fresh = inspect_retained_status_v1(&root, &cancelled, deadline).unwrap();
        fresh.assert_current().unwrap();
        symlink(&root, &first).unwrap();
        assert!(fresh.assert_current().is_err());
        drop(observed);
        drop(fresh);
        fs::remove_file(first).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn missing_lock_final_edge_retains_epoch_and_original_controls_without_revival() {
    let root = root("lock");
    let context = root.join("runtime-images/r-scientific");
    fs::create_dir_all(&context).unwrap();
    let cancelled = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    let observed = inspect_retained_status_v1(&root, &cancelled, deadline).unwrap();
    assert_eq!(
        observed.report["blockers"][0],
        format!(
            "r_runtime_source_cas_unavailable:ENOENT: no such file or directory, open '{}'",
            context.join("renv.lock").display()
        )
    );
    observed.assert_current().unwrap();
    let path = context.join("renv.lock");
    fs::write(&path, b"{}").unwrap();
    fs::remove_file(&path).unwrap();
    assert!(observed.assert_current().is_err());
    let fresh = inspect_retained_status_v1(&root, &cancelled, deadline).unwrap();
    fresh.assert_current().unwrap();
    cancelled.store(true, Ordering::Release);
    assert!(fresh.assert_current().is_err());
    assert!(inspect_retained_status_v1(&root, &cancelled, deadline).is_err());
    cancelled.store(false, Ordering::Release);
    assert!(
        inspect_retained_status_v1(&root, &cancelled, Instant::now() - Duration::from_secs(1))
            .is_err()
    );
    drop(observed);
    drop(fresh);
    fs::remove_dir_all(root).unwrap();
}
