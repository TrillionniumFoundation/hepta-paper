use super::*;
use nix::fcntl::{Flock, FlockArg};

fn records(temp: &Temp) -> BTreeSet<String> {
    fs::read_dir(temp.0.join("attempts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

#[test]
fn changed_plan_cannot_escape_an_unprepared_start_after_owner_reopen() {
    let temp = Temp::new();
    let failed =
        configuration_for_job(&temp, NativeBusinessJobV1::BuildPackage { entries: vec![] });
    assert!(run_service_v1(failed).is_err());
    let before = records(&temp);
    assert_eq!(before.len(), 1);
    assert!(before.iter().all(|name| name.ends_with(".started")));
    // New service, fresh request payload and different plan hash, same durable owner.
    // Previously this valid build could dispatch despite the unresolved first start.
    let next = build_configuration(&temp);
    assert!(run_service_v1(next).is_err());
    assert_eq!(records(&temp), before);
}

#[test]
fn independent_executor_descriptor_cannot_dispatch_under_held_directory_lock() {
    let temp = Temp::new();
    let config = build_configuration(&temp);
    let directory = fs::File::open(temp.0.join("attempts")).unwrap();
    let guard = Flock::lock(directory, FlockArg::LockExclusiveNonblock).unwrap();
    assert!(run_service_v1(config.clone()).is_err());
    assert!(records(&temp).is_empty());
    drop(guard);
    let receipt = run_service_v1(config).unwrap();
    assert_eq!(receipt.commit_receipts.len(), 1);
    assert!(receipt.commit_receipts[0].newly_committed);
}

#[test]
fn orphan_prepared_cache_and_corrupt_start_block_new_dispatch_without_cleanup() {
    for orphan_prepared in [true, false] {
        let temp = Temp::new();
        let config = build_configuration(&temp);
        run_service_v1(config.clone()).unwrap();
        let start = records(&temp)
            .into_iter()
            .find(|name| name.ends_with(".started"))
            .unwrap();
        if orphan_prepared {
            fs::remove_file(temp.0.join("attempts").join(start)).unwrap();
        } else {
            fs::write(
                temp.0.join("attempts").join(start),
                b"wrong dispatch identity",
            )
            .unwrap();
        }
        let before = records(&temp);
        assert!(run_service_v1(config).is_err());
        assert_eq!(records(&temp), before);
    }
}

#[test]
fn unknown_attempt_record_blocks_execution_instead_of_being_ignored() {
    let temp = Temp::new();
    let config = build_configuration(&temp);
    fs::write(
        temp.0.join("attempts").join("unclassified-record"),
        b"residue",
    )
    .unwrap();
    let before = records(&temp);
    assert!(run_service_v1(config).is_err());
    assert_eq!(records(&temp), before);
}
