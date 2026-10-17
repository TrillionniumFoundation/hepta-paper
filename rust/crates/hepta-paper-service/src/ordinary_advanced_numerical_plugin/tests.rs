use super::*;
use std::{fs, os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
#[test]
fn ordinary_numerical_original_controls_and_writer_preflight_are_bounded() {
    let c = AtomicBool::new(true);
    let d = Instant::now() + std::time::Duration::from_secs(120);
    assert!(
        run_ordinary_advanced_numerical_plugin_status_v1(&[], &c, d)
            .unwrap_err()
            .contains("cancelled")
    );
    c.store(false, Ordering::Release);
    assert!(
        run_ordinary_advanced_numerical_plugin_status_v1(&[], &c, Instant::now())
            .unwrap_err()
            .contains("deadline")
    );
    assert!(
        run_ordinary_advanced_numerical_plugin_status_v1(&["--action=run".into()], &c, d)
            .unwrap_err()
            .contains("configuration_path_required")
    );
    let help = run_ordinary_advanced_numerical_plugin_status_v1(&["--help".into()], &c, d).unwrap();
    assert_eq!(help.exit_code, 0);
    assert!(
        String::from_utf8(help.stdout)
            .unwrap()
            .contains("AdvancedNumericalPluginUsage")
    );
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "hepta-numerical-held-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        // Keep real failed inputs for diagnosis; never delete an unknown path.
        if !std::thread::panicking() {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
}
fn held_report<'a>(root: &Path, c: &'a AtomicBool, d: Instant) -> ObservedStatus<'a> {
    let mut source = StatusInputs::new(c, d).unwrap();
    assert_eq!(
        source.document(&root.join("config.json"), 4096).unwrap(),
        b"{\"version\":1}\n"
    );
    ObservedStatus {
        cpu_witness: None,
        report: object([("observed", Json::Bool(true))]),
        source,
        c,
        d,
        exit: 0,
        authority: None,
        qualification: None,
    }
}

#[test]
fn ordinary_numerical_selected_root_alias_is_retained_and_retargeting_is_refused() {
    let root = Scratch::new();
    for name in ["original", "replacement"] {
        fs::create_dir(root.0.join(name)).unwrap();
        fs::write(root.0.join(name).join("config.json"), b"{\"version\":1}\n").unwrap();
    }
    let selected = root.0.join("selected");
    std::os::unix::fs::symlink(root.0.join("original"), &selected).unwrap();
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    assert_eq!(held_report(&selected, &c, d).finish().unwrap().exit_code, 0);
    let retained = held_report(&selected, &c, d);
    fs::remove_file(&selected).unwrap();
    std::os::unix::fs::symlink(root.0.join("replacement"), &selected).unwrap();
    assert!(retained.finish().unwrap_err().contains("input_changed"));
    assert_eq!(
        fs::read(root.0.join("original/config.json")).unwrap(),
        b"{\"version\":1}\n"
    );
}
#[test]
fn ordinary_numerical_retained_input_drift_wire_budget_and_fresh_control_are_refused() {
    let root = Scratch::new();
    let path = root.0.join("config.json");
    fs::write(&path, b"{\"version\":1}\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    assert_eq!(held_report(&root.0, &c, d).finish().unwrap().exit_code, 0);
    let retained = held_report(&root.0, &c, d);
    fs::rename(&path, root.0.join("held.json")).unwrap();
    fs::write(&path, b"{\"version\":1}\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
    assert!(retained.finish().unwrap_err().contains("input_changed"));
    assert_eq!(held_report(&root.0, &c, d).finish().unwrap().exit_code, 0);
    let retained = held_report(&root.0, &c, d);
    c.store(true, Ordering::Release);
    assert!(retained.finish().unwrap_err().contains("cancelled"));
    let fresh = AtomicBool::new(false);
    assert_eq!(
        held_report(&root.0, &fresh, d).finish().unwrap().exit_code,
        0
    );
    let mut report = held_report(&root.0, &fresh, d);
    report.report = text(&"x".repeat(4 * 1024 * 1024));
    assert!(report.finish().is_err());
    let expires = Instant::now() + Duration::from_millis(50);
    let report = held_report(&root.0, &fresh, expires);
    std::thread::sleep(Duration::from_millis(60));
    assert!(report.finish().unwrap_err().contains("deadline"));
    assert_eq!(
        held_report(&root.0, &fresh, d).finish().unwrap().exit_code,
        0
    );
}
#[test]
fn ordinary_numerical_actual_probe_cancel_deadline_cleanup_then_fresh_retry() {
    let c = Arc::new(AtomicBool::new(false));
    let d = Instant::now() + Duration::from_secs(120);
    let mut source = StatusInputs::new(&c, d).unwrap();
    source
        .archive(Path::new("/usr/bin/sleep"), 16 * 1024 * 1024)
        .unwrap();
    let thread_flag = Arc::clone(&c);
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        thread_flag.store(true, Ordering::Release);
    });
    let cancelled = sandbox::invoke(Path::new("/usr/bin/sleep"), &["30"], &source, &c, d, 5000);
    thread.join().unwrap();
    assert!(cancelled.unwrap_err().contains("cancelled"));
    let fresh = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let mut source = StatusInputs::new(&fresh, d).unwrap();
    source
        .archive(Path::new("/usr/bin/sleep"), 16 * 1024 * 1024)
        .unwrap();
    assert!(sandbox::invoke(Path::new("/usr/bin/sleep"), &["30"], &source, &fresh, d, 50).is_err());
    assert_eq!(
        sandbox::invoke(
            Path::new("/usr/bin/sleep"),
            &["0"],
            &source,
            &fresh,
            d,
            5000
        )
        .unwrap()
        .0,
        0
    );
    source.assert_current().unwrap();
}

#[test]
fn ordinary_numerical_actual_parent_namespace_drift_refuses_until_fresh_observation() {
    let first = Scratch::new();
    let path = first.0.join("config.json");
    fs::write(&path, b"{\"version\":1}\n").unwrap();
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let relative = path.strip_prefix("/").unwrap();
    let mut held = SourceObservation::new_with_deadline(Path::new("/"), &c, d).unwrap();
    let initial = held.inventory_document(relative, 4096).unwrap();
    let unrelated_sibling = Scratch::new();
    assert_ne!(unrelated_sibling.0, first.0);
    assert!(held.inventory_probe(relative).unwrap().is_some());
    let missing = first.0.join("not-yet-present.json");
    assert!(
        held.inventory_probe(missing.strip_prefix("/").unwrap())
            .unwrap()
            .is_none()
    );
    // An absence observation seals the actual parent namespace. A new adjacent
    // entry changes that observed input even when the retained file bytes agree.
    fs::write(
        first.0.join("new-adjacent.json"),
        b"new observed parent entry",
    )
    .unwrap();
    assert!(
        held.inventory_probe(relative)
            .unwrap_err()
            .contains("input_changed")
    );
    assert_eq!(fs::read(&path).unwrap(), initial);
    let mut fresh = SourceObservation::new_with_deadline(Path::new("/"), &c, d).unwrap();
    assert!(fresh.inventory_probe(relative).unwrap().is_some());
    assert_eq!(fresh.inventory_document(relative, 4096).unwrap(), initial);
    fresh.assert_current().unwrap();
}

#[test]
fn ordinary_numerical_fixed_input_scopes_keep_files_and_directory_edges_current() {
    let root = Scratch::new();
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    for name in ["config.json", "bundle.json", "key.json", "tool"] {
        let path = root.0.join(name);
        fs::write(&path, b"{\"version\":1}\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
        let mut source = StatusInputs::new(&c, d).unwrap();
        assert!(source.probe(&path).unwrap().is_some());
        assert_eq!(source.document(&path, 4096).unwrap(), b"{\"version\":1}\n");
        let sibling = Scratch::new();
        assert_ne!(sibling.0, root.0);
        assert!(source.probe(&path).unwrap().is_some());
        source.assert_current().unwrap();
        // The same byte content at a different inode is still replacement.
        fs::rename(&path, root.0.join(format!("{name}.retained"))).unwrap();
        fs::write(&path, b"{\"version\":1}\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
        assert!(
            source
                .assert_current()
                .unwrap_err()
                .contains("input_changed")
        );
        let mut fresh = StatusInputs::new(&c, d).unwrap();
        assert_eq!(fresh.document(&path, 4096).unwrap(), b"{\"version\":1}\n");
        fresh.assert_current().unwrap();
    }
    let directory = root.0.join("plugin");
    fs::create_dir(&directory).unwrap();
    let mut source = StatusInputs::new(&c, d).unwrap();
    assert!(source.directory(&directory).unwrap());
    fs::rename(&directory, root.0.join("retained-plugin")).unwrap();
    fs::create_dir(&directory).unwrap();
    assert!(
        source
            .assert_current()
            .unwrap_err()
            .contains("input_changed")
    );
    let mut fresh = StatusInputs::new(&c, d).unwrap();
    assert!(fresh.directory(&directory).unwrap());
    let missing = directory.join("absent.json");
    assert!(fresh.probe(&missing).unwrap().is_none());
    // A genuinely observed missing edge retains its original full namespace.
    fs::write(directory.join("other.json"), b"{}").unwrap();
    assert!(
        fresh
            .assert_current()
            .unwrap_err()
            .contains("input_changed")
    );
    let mut fresh = StatusInputs::new(&c, d).unwrap();
    assert!(fresh.probe(&missing).unwrap().is_none());
    fresh.assert_current().unwrap();
}

#[test]
fn ordinary_numerical_fixed_input_scopes_share_original_budget_and_control() {
    let first = Scratch::new();
    let second = Scratch::new();
    let a = first.0.join("a.json");
    let b = second.0.join("b.json");
    fs::write(&a, b"{}").unwrap();
    fs::write(&b, b"{}").unwrap();
    let c = AtomicBool::new(false);
    let other = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let mut source = StatusInputs::with_prior_reservation(&c, d, 1024 * 1024 * 1024 - 2).unwrap();
    assert_eq!(source.document(&a, 4096).unwrap(), b"{}");
    assert_eq!(
        source.document(&b, 4096).unwrap_err(),
        "r_runtime_source_cas_observation_limit_exceeded"
    );
    assert!(
        source
            .require_control(&other, d)
            .unwrap_err()
            .contains("context_mismatch")
    );
    assert!(
        source
            .require_control(&c, d + Duration::from_millis(1))
            .unwrap_err()
            .contains("context_mismatch")
    );
    let mut fresh = StatusInputs::new(&c, d).unwrap();
    assert_eq!(fresh.document(&a, 4096).unwrap(), b"{}");
    assert_eq!(fresh.document(&b, 4096).unwrap(), b"{}");
    fresh.require_control(&c, d).unwrap();
    c.store(true, Ordering::Release);
    assert!(fresh.assert_current().unwrap_err().contains("cancelled"));
    let expires = Instant::now() + Duration::from_millis(20);
    let mut fresh = StatusInputs::new(&other, expires).unwrap();
    assert_eq!(fresh.document(&a, 4096).unwrap(), b"{}");
    std::thread::sleep(Duration::from_millis(30));
    assert!(fresh.assert_current().unwrap_err().contains("deadline"));
    let mut fresh = StatusInputs::new(&other, d).unwrap();
    assert_eq!(fresh.document(&a, 4096).unwrap(), b"{}");
    fresh.require_control(&other, d).unwrap();
}
